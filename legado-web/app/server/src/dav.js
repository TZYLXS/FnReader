'use strict';
// 极简 WebDAV 服务：让「阅读」App 直接挂载飞牛上的书架
//   /dav/books/   书架里已下载的书（只读，.txt）
//   /dav/backup/  可读写，存放 Legado 的备份文件
const fs = require('node:fs');
const path = require('node:path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hrefOf(p) {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function davAuth(ctx, req, url) {
  const token = ctx.apiToken();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const idx = raw.indexOf(':');
      const pass = idx >= 0 ? raw.slice(idx + 1) : '';
      if (pass === token) return true;
    } catch {
      /* ignore */
    }
  }
  const t = req.headers['x-api-token'] || url.searchParams.get('token');
  return !!t && t === token;
}

function propResponse(href, { dir, size = 0, mtime = Date.now() }) {
  const name = href.endsWith('/') ? href.split('/').filter(Boolean).pop() || 'dav' : href.split('/').pop();
  return (
    '<D:response>' +
    `<D:href>${esc(href)}</D:href>` +
    '<D:propstat><D:prop>' +
    `<D:displayname>${esc(decodeURIComponent(name))}</D:displayname>` +
    (dir
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : '<D:resourcetype/><D:getcontentlength>' + size + '</D:getcontentlength><D:getcontenttype>text/plain; charset=utf-8</D:getcontenttype>') +
    `<D:getlastmodified>${new Date(mtime).toUTCString()}</D:getlastmodified>` +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
  );
}

function sendXml(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function safeJoin(root, rel) {
  const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!target.startsWith(path.resolve(root))) return null;
  return target;
}

/**
 * @param {object} ctx { apiToken, readJSON, DOWNLOAD_INDEX, dataDir }
 */
async function handleDav(ctx, req, res, url, p, method) {
  if (!davAuth(ctx, req, url)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="FnReader"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('需要令牌：用户名随意，密码填「设置 → 手机接入」里的访问令牌');
  }

  if (method === 'OPTIONS') {
    res.writeHead(200, {
      DAV: '1, 2',
      'MS-Author-Via': 'DAV',
      Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL',
      'Content-Length': '0',
    });
    return res.end();
  }

  const root = '/dav';
  let rel = p.slice(root.length) || '/';
  if (!rel.startsWith('/')) rel = '/' + rel;
  const isRoot = rel === '/' || rel === '';
  const parts = rel.split('/').filter(Boolean);
  const first = parts[0] || '';

  const backupRoot = path.join(ctx.dataDir, 'webdav', 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });

  const listing = (basePath, entries) => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:multistatus xmlns:D="DAV:">' +
      propResponse(basePath, { dir: true }) +
      entries.join('') +
      '</D:multistatus>';
    sendXml(res, 207, body);
  };

  // 根目录
  if (isRoot) {
    if (method === 'PROPFIND') {
      return listing('/dav/', [propResponse('/dav/books/', { dir: true }), propResponse('/dav/backup/', { dir: true })]);
    }
    return sendXml(res, 200, '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>');
  }

  // 书架
  if (first === 'books') {
    const list = ctx.readJSON(ctx.DOWNLOAD_INDEX, []);
    if (parts.length === 1) {
      if (method === 'PROPFIND') {
        const entries = list
          .filter((e) => e.file && fs.existsSync(e.file))
          .map((e) => {
            const name = (e.name || 'book') + '.txt';
            return propResponse('/dav/books/' + hrefOf(name), { dir: false, size: e.size || 0, mtime: e.time || Date.now() });
          });
        entries.unshift(
          propResponse('/dav/books/manifest.json', {
            dir: false,
            size: Buffer.byteLength(JSON.stringify(ctx.manifest())),
          })
        );
        return listing('/dav/books/', entries);
      }
      return sendXml(res, 200, '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>');
    }
    const want = decodeURIComponent(parts.slice(1).join('/'));

    // 书架清单 JSON：给 App 一键同步用
    if (want === 'manifest.json' && (method === 'GET' || method === 'HEAD')) {
      const body = JSON.stringify(ctx.manifest(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      if (method === 'HEAD') return res.end();
      return res.end(body);
    }
    const entry = list.find((e) => (e.name || 'book') + '.txt' === want);
    if (!entry || !entry.file || !fs.existsSync(entry.file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('没有这本书');
    }
    if (method === 'PROPFIND') {
      return listing('/dav/books/', [
        propResponse('/dav/books/' + hrefOf(want), { dir: false, size: fs.statSync(entry.file).size, mtime: entry.time || Date.now() }),
      ]);
    }
    if (method === 'GET' || method === 'HEAD') {
      const stat = fs.statSync(entry.file);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': stat.size,
        'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(entry.file).pipe(res);
    }
    res.writeHead(405, { Allow: 'GET, HEAD, PROPFIND' });
    return res.end();
  }

  // 备份目录（可读写）
  if (first === 'backup') {
    const sub = parts.slice(1).join('/');
    const target = safeJoin(backupRoot, sub);
    if (!target) {
      res.writeHead(400);
      return res.end('bad path');
    }
    const exists = fs.existsSync(target);
    const isDir = exists && fs.statSync(target).isDirectory();

    if (method === 'PROPFIND') {
      if (!exists) {
        res.writeHead(404);
        return res.end();
      }
      const href = '/dav/backup/' + (sub ? hrefOf(sub) + (isDir ? '/' : '') : '');
      if (!isDir) {
        const st = fs.statSync(target);
        return listing('/dav/backup/', [propResponse(href, { dir: false, size: st.size, mtime: st.mtimeMs })]);
      }
      const entries = fs.readdirSync(target).map((n) => {
        const full = path.join(target, n);
        const st = fs.statSync(full);
        return propResponse(href + hrefOf(n) + (st.isDirectory() ? '/' : ''), {
          dir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
        });
      });
      return listing(href, entries);
    }

    if (method === 'MKCOL') {
      if (exists) {
        res.writeHead(405);
        return res.end();
      }
      fs.mkdirSync(target, { recursive: true });
      res.writeHead(201);
      return res.end();
    }

    if (method === 'PUT') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fs.writeFileSync(target, Buffer.concat(chunks));
      res.writeHead(exists ? 204 : 201);
      return res.end();
    }

    if (method === 'DELETE') {
      if (!exists) {
        res.writeHead(404);
        return res.end();
      }
      fs.rmSync(target, { recursive: true, force: true });
      res.writeHead(204);
      return res.end();
    }

    if ((method === 'GET' || method === 'HEAD') && exists && !isDir) {
      const st = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(target).pipe(res);
    }

    res.writeHead(405);
    return res.end();
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('not found');
}

module.exports = { handleDav };
