'use strict';

/* ---------------- 基础工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const toastEl = $('#toast');

function coverSrc(url, bookUrl) {
  if (!url) return '';
  return './api/image?url=' + encodeURIComponent(url) + (bookUrl ? '&book=' + encodeURIComponent(bookUrl) : '');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

async function api(path, opts = {}) {
  // /api/m/* 需要令牌；网页端自己也知道令牌，直接带上，避免 401
  const headers = { 'Content-Type': 'application/json' };
  const token = state.config && state.config.apiToken;
  if (token) headers['X-Api-Token'] = token;
  const res = await fetch('./api' + path, {
    headers,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok || data.error) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// 页面里由打包脚本写入的版本号（release.py 会同步）
const APP_VER = (document.querySelector('meta[name="app-version"]') || { content: '' }).content || '';

const state = {
  books: [],
  sources: [],
  config: { theme: 'light', fontSize: 19, lineHeight: 1.85, pageWidth: 720 },
  search: { key: '', selected: new Set(), running: false, es: null, results: [] },
  reader: null,
};

/* ---------------- 配置 ---------------- */
function applyConfig(cfg) {
  state.config = { ...state.config, ...cfg };
  document.documentElement.setAttribute('data-theme', state.config.theme || 'light');
  const root = document.documentElement.style;
  root.setProperty('--font-size', state.config.fontSize + 'px');
  root.setProperty('--line-height', state.config.lineHeight);
  root.setProperty('--page-width', state.config.pageWidth + 'px');
  // 液态玻璃底栏
  if (state.config.liquidGlass) document.documentElement.setAttribute('data-glass', '1');
  else document.documentElement.removeAttribute('data-glass');
}

async function saveConfig(patch) {
  applyConfig(patch);
  try {
    await api('/config', { method: 'POST', body: patch });
  } catch (e) {
    toast('保存设置失败：' + e.message);
  }
}

/* ---------------- 事件流：App 回传的进度实时同步到网页 ---------------- */
function connectEvents() {
  if (state.events) return;
  try {
    const es = new EventSource('./api/events');
    state.events = es;
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== 'progress') return;
      const book = (state.books || []).find((b) => b.bookUrl === msg.bookUrl);
      if (book) {
        book.durChapterIndex = msg.index;
        book.durChapterTitle = msg.title;
        book.durChapterTime = msg.at || Date.now();
        if (location.hash.startsWith('#/shelf')) renderShelf();
      }
      if (msg.via === 'app') toast(`App 已同步进度：${msg.title || ''}`);
    };
    es.onerror = () => {
      es.close();
      state.events = null;
      setTimeout(connectEvents, 5000);
    };
  } catch {
    /* 环境不支持 EventSource 就忽略 */
  }
}

/* ---------------- 路由 ---------------- */
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/shelf';
  const [path, qs] = raw.split('?');
  return { path, params: new URLSearchParams(qs || '') };
}

async function router() {
  const { path, params } = parseHash();
  // 订阅并入「搜索」页，底部只保留 4 个标签
  const raw = path.split('/')[1] || 'shelf';
  const tab = raw === 'feeds' ? 'search' : raw;
  $$('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (!path.startsWith('/sources')) {
    const bulk = document.getElementById('source-bulk');
    if (bulk) bulk.remove();
  }
  $('#tabbar').style.display = path.startsWith('/read') ? 'none' : 'grid';
  if (state.search.es && tab !== 'search') {
    state.search.es.close();
    state.search.es = null;
    state.search.running = false;
  }
  window.scrollTo(0, 0);
  if (path === '/shelf') return renderShelf();
  if (path === '/search') return renderSearch();
  if (path === '/sources') return renderSources();
  if (path === '/settings') return renderSettings();
  if (path === '/bus') return renderBus();
  if (path === '/detail') return renderDetail();
  if (path === '/feeds') return renderFeeds();
  if (path === '/downloads') return renderDownloads();
  if (path.startsWith('/read')) return openReader(params.get('url'), params.get('title'));
  return renderShelf();
}

/* ---------------- 书架 ---------------- */
async function loadBooks() {
  const { books } = await api('/books');
  state.books = books;
  return books;
}

async function renderShelf() {
  view.innerHTML = `
    <header class="topbar"><h1>书架</h1><button class="btn ghost" id="refresh-all">刷新目录</button></header>
    <div id="shelf-body"><div class="empty"><div class="big">📚</div>正在加载…</div></div>`;
  const body = $('#shelf-body');
  $('#refresh-all').onclick = refreshAllTocs;
  try {
    const books = await loadBooks();
    if (!books.length) {
      body.innerHTML = `<div class="empty"><div class="big">📖</div>书架还是空的<br />去「搜索」里找一本书，或先导入书源</div>`;
      return;
    }
    body.innerHTML = `<div class="shelf">${books
      .map(
        (b) => `
      <div class="book-card" data-url="${esc(b.bookUrl)}">
        <div class="cover"><span class="ph">${esc((b.name || '?').slice(0, 1))}</span>${
          b.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(b.coverUrl, b.bookUrl))}" onerror="this.remove()" />` : ''
        }
          ${b.durChapterTitle ? `<span class="badge">${esc(b.durChapterTitle)}</span>` : ''}
        </div>
        <div class="name">${esc(b.name)}</div>
        <div class="meta">${esc(b.durChapterIndex ? `读到 ${b.durChapterIndex + 1}/${b.totalChapterNum || '?'} 章` : b.author || '')}</div>
        <button class="more" data-more="1" aria-label="更多">⋯</button>
      </div>`
      )
      .join('')}</div>`;

    bindShelfEvents(body);
  } catch (e) {
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 书架交互：
 * - 点封面/书名：继续阅读
 * - 点右上角「⋯」：打开管理菜单（比长按可靠）
 * - 长按封面：也打开菜单，并吞掉随后产生的 click，避免“菜单弹出来又跳进阅读页”
 */
function bindShelfEvents(body) {
  let pressTimer = null;
  let suppressClick = false;
  let pressedCard = null;

  const clearTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (pressedCard) pressedCard.classList.remove('pressing');
    pressedCard = null;
  };

  body.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.book-card');
    if (!card || e.target.closest('[data-more]')) return;
    suppressClick = false;
    pressedCard = card;
    card.classList.add('pressing');
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      card.classList.remove('pressing');
      bookMenu(card.dataset.url);
    }, 520);
  });

  body.addEventListener('pointerup', clearTimer);
  body.addEventListener('pointercancel', clearTimer);
  body.addEventListener('pointerleave', clearTimer);
  body.addEventListener('pointermove', (e) => {
    // 手指滑动（滚动）就取消长按
    if (pressedCard && (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6)) clearTimer();
  });

  body.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      e.preventDefault();
      e.stopPropagation();
      const card = more.closest('.book-card');
      if (card) bookMenu(card.dataset.url);
      return;
    }
    const card = e.target.closest('.book-card');
    if (!card) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    location.hash = '#/read?url=' + encodeURIComponent(card.dataset.url);
  });

  // 长按不弹出浏览器自带菜单
  body.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.book-card')) e.preventDefault();
  });
}

async function refreshAllTocs() {
  if (!state.books.length) return toast('书架是空的');
  if (!confirm(`重新获取 ${state.books.length} 本书的目录？书源响应慢时可能需要一会儿。`)) return;
  let done = 0;
  for (const book of state.books) {
    toast(`正在刷新目录 ${done + 1}/${state.books.length}：${book.name}`);
    try {
      const r = await fetch('./api/toc?url=' + encodeURIComponent(book.bookUrl) + '&refresh=1').then((x) => x.json());
      if (r.chapters) book.totalChapterNum = r.chapters.length;
    } catch {
      /* 单本失败不影响其他 */
    }
    done++;
  }
  toast('目录刷新完成');
  renderShelf();
}

async function bookMenu(bookUrl) {
  const book = state.books.find((b) => b.bookUrl === bookUrl);
  if (!book) return;
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>${esc(book.name)}</h3>
    <p style="color:var(--text-2);font-size:13px;margin:-6px 0 14px">${esc(book.author || '')}${book.totalChapterNum ? ' · ' + book.totalChapterNum + ' 章' : ''}</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" id="act-read">继续阅读</button>
      <button class="btn" id="act-dl">下载整本为 TXT</button>
      <button class="btn" id="act-toc">刷新目录</button>
      <button class="btn" id="act-del" style="color:var(--danger)">从书架删除</button>
    </div>
    <div class="modal-actions"><button class="btn primary" id="act-close">取消</button></div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#act-close').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  $('#act-read').onclick = () => {
    close();
    location.hash = '#/read?url=' + encodeURIComponent(bookUrl);
  };
  $('#act-dl').onclick = () => {
    close();
    startDownloadFlow(bookUrl, book.name);
  };
  $('#act-toc').onclick = async () => {
    close();
    toast('正在刷新目录…');
    try {
      const r = await api('/toc?url=' + encodeURIComponent(bookUrl) + '&refresh=1');
      toast(`目录已更新，共 ${r.chapters ? r.chapters.length : 0} 章`);
      renderShelf();
    } catch (e) {
      toast('刷新失败：' + e.message);
    }
  };
  $('#act-del').onclick = async () => {
    close();
    if (!confirm(`确定把《${book.name}》从书架删除？`)) return;
    try {
      await api('/books?url=' + encodeURIComponent(bookUrl), { method: 'DELETE' });
      toast('已删除');
      renderShelf();
    } catch (e) {
      toast('删除失败：' + e.message);
    }
  };
}

/* ---------------- 下载整本 TXT ---------------- */
let dlTimer = null;

function showDownloadBar(html) {
  let bar = $('#dl-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dl-bar';
    bar.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(var(--tabbar-h) + 16px);z-index:55;' +
      'background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:13px;display:flex;align-items:center;gap:10px';
    document.body.appendChild(bar);
  }
  bar.innerHTML = html;
  bar.style.display = 'flex';
  return bar;
}

function hideDownloadBar() {
  const bar = $('#dl-bar');
  if (bar) bar.style.display = 'none';
}

async function startDownloadFlow(bookUrl, name) {
  try {
    const r = await api('/download', { method: 'POST', body: { url: bookUrl } });
    toast(`开始下载《${name}》，共 ${r.total} 章`);
  } catch (e) {
    return toast('开始下载失败：' + e.message);
  }

  clearInterval(dlTimer);
  const poll = async () => {
    let st;
    try {
      st = await api('/download/status?url=' + encodeURIComponent(bookUrl));
    } catch {
      return;
    }
    if (st.running) {
      const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
      showDownloadBar(
        `<span class="spinner"></span><span style="flex:1">下载中 ${st.done}/${st.total}（${pct}%）${st.failed ? ' · 失败 ' + st.failed : ''}</span>
         <button class="btn" id="dl-cancel" style="padding:4px 10px;font-size:12px">取消</button>`
      );
      const c = $('#dl-cancel');
      if (c) c.onclick = () => api('/download/cancel', { method: 'POST', body: { url: bookUrl } }).catch(() => {});
      return;
    }
    clearInterval(dlTimer);
    dlTimer = null;
    if (st.file) {
      hideDownloadBar();
      toast(`《${name}》已合并为 TXT，开始下载`);
      const a = document.createElement('a');
      a.href = './api/download/file?url=' + encodeURIComponent(bookUrl);
      a.download = st.file;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      showDownloadBar(`<span style="flex:1;color:var(--danger)">下载失败：${esc(st.error || '未知错误')}</span>`);
      setTimeout(hideDownloadBar, 4000);
    }
  };
  poll();
  dlTimer = setInterval(poll, 1500);
}

/* ---------------- 搜索 ---------------- */
async function ensureSources() {
  if (!state.sources.length) {
    const { sources } = await api('/sources');
    state.sources = sources;
  }
  return state.sources;
}

async function renderSearch() {
  view.innerHTML = `
    <header class="topbar"><h1>搜索</h1><span class="sub" id="src-count"></span></header>
    <div class="chips" id="mode-row" style="padding-bottom:0">
      <button class="chip on" data-mode="book">找书</button>
      <button class="chip" data-mode="feed">订阅</button>
      <button class="chip ${state.search.remote ? 'on' : ''}" id="chip-remote" title="用手机端解析器搜索">📱 手机解析</button>
    </div>
    <div class="searchbar">
      <input id="kw" type="search" placeholder="书名 / 作者" enterkeyhint="search" />
      <select id="scope" class="scope-select" aria-label="搜索范围"></select>
      <button class="btn primary" id="go">搜索</button>
    </div>
    <div class="progress-line" id="academic-hint" style="display:none"></div>
    <div class="progress-line" id="search-status"></div>
    <div class="results" id="results"></div>`;

  $('#mode-row').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.id === 'chip-remote') {
      state.search.remote = !state.search.remote;
      b.classList.toggle('on', state.search.remote);
      toast(state.search.remote ? '已开启手机解析：本机解析失败的源会交给手机' : '已关闭手机解析');
      return;
    }
    if (b.dataset.mode === 'feed') location.hash = '#/feeds';
  };

  const sources = await ensureSources().catch(() => []);
  const okCount = sources.filter((s) => s.checkStatus === 'ok').length;
  $('#src-count').textContent = sources.length
    ? `${sources.filter((s) => s.enabled).length} 个启用${okCount ? ` · ${okCount} 个可用` : ''}`
    : '';
  // 搜索范围下拉：全部书源 / 仅可用 / 按分组（PC 上也不会有横向滚动问题）
  const scope = $('#scope');
  const groupCount = new Map();
  for (const src of sources) {
    const g = src.bookSourceGroup || '未分组';
    groupCount.set(g, (groupCount.get(g) || 0) + 1);
  }
  const groups = [...groupCount.entries()].sort((a, b) => b[1] - a[1]);

  scope.innerHTML =
    `<option value="all">全部书源（${sources.filter((x) => x.enabled).length}）</option>` +
    (okCount ? `<option value="only">仅可用（${okCount}）</option>` : '') +
    `<optgroup label="按分组">` +
    groups.map(([g, n]) => `<option value="g:${esc(g)}">${esc(g)}（${n}）</option>`).join('') +
    `</optgroup>`;

  state.search.onlyChecked = !!okCount;
  state.search.group = '';
  scope.value = okCount ? 'only' : 'all';

  scope.onchange = () => {
    const v = scope.value;
    state.search.selected.clear();
    if (v === 'only') {
      state.search.onlyChecked = true;
      state.search.group = '';
    } else if (v === 'all') {
      state.search.onlyChecked = false;
      state.search.group = '';
    } else if (v.startsWith('g:')) {
      state.search.onlyChecked = false;
      state.search.group = v.slice(2);
    }
  };

  const input = $('#kw');
  input.value = state.search.key || '';
  const start = () => startSearch(input.value.trim());
  $('#go').onclick = start;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });

  if (state.search.key) {
    renderSearchResults();
    input.focus();
  }

  const pre = parseHash().params.get('key');
  if (pre) {
    input.value = pre;
    startSearch(pre);
  }
}

async function renderBus() {
  view.innerHTML = `
    <header class="topbar"><button class="icon-btn" id="bus-back">‹</button><h1>软总线</h1>
      <button class="btn" id="bus-refresh" style="padding:5px 10px;font-size:12px">刷新</button>
    </header>
    <div class="progress-line" id="bus-hint">正在扫描可用解析设备…</div>
    <div id="bus-list"><div class="empty"><span class="spinner"></span> 加载中…</div></div>`;

  $('#bus-back').onclick = () => (location.hash = '#/settings');
  $('#bus-refresh').onclick = () => loadBus();

  async function loadBus() {
    const box = $('#bus-list');
    const hint = $('#bus-hint');
    try {
      const r = await api('/bus');
      const devs = r.devices || [];
      const online = devs.filter((d) => d.online).length;
      hint.textContent = `待命设备 ${online} 台 · 等待中的任务 ${r.pending || 0} 个`;

      if (!devs.length) {
        box.innerHTML = `<div class="empty"><div class="big">📱</div>还没有手机接入软总线<br />
          在 App 里打开「解析待命」即可出现在这里</div>`;
        return;
      }

      box.innerHTML = devs
        .map(
          (d) => `
        <div class="section" style="margin:12px 14px">
          <div class="row">
            <div class="label">
              <b>${esc(d.name)} ${d.online ? '<span class="tag" style="background:var(--accent-soft);color:var(--accent)">在线</span>' : '<span class="tag">离线</span>'}</b>
              <div class="desc">${esc(d.model || '未知机型')}${d.version ? ' · v' + esc(d.version) : ''} · ${d.online ? '刚刚活跃' : d.idle + ' 秒前'}</div>
            </div>
            <div class="switch ${d.enabled ? 'on' : ''}" data-toggle="${esc(d.id)}"></div>
          </div>
          <div class="row"><div class="label">已代理解析<div class="desc">${d.handled || 0} 次</div></div></div>
        </div>`
        )
        .join('');

      box.onclick = async (e) => {
        const t = e.target.dataset.toggle;
        if (t == null) return;
        const on = e.target.classList.contains('on');
        try {
          await api('/bus/toggle', { method: 'POST', body: { id: t, enabled: !on } });
          e.target.classList.toggle('on', !on);
          toast(!on ? '已允许该设备代理解析' : '已暂停该设备');
        } catch (err) {
          toast('操作失败：' + err.message);
        }
      };
    } catch (e) {
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  await loadBus();
  clearInterval(state.busTimer);
  state.busTimer = setInterval(() => {
    if (location.hash.startsWith('#/bus')) loadBus();
    else clearInterval(state.busTimer);
  }, 5000);
}

async function renderDetail() {
  const { params } = parseHash();
  const url = params.get('url') || '';
  const origin = params.get('origin') || '';
  if (!url) {
    view.innerHTML = '<div class="empty">缺少书籍地址</div>';
    return;
  }

  const cached = state.detail && state.detail.bookUrl === url ? state.detail : null;
  view.innerHTML = `
    <header class="topbar"><button class="icon-btn" id="detail-back">‹</button><h1>书籍详情</h1></header>
    <div id="detail-body">${cached ? '' : '<div class="empty"><span class="spinner"></span> 加载中…</div>'}</div>`;

  $('#detail-back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/search');

  let data = cached ? { book: cached, inShelf: state.books.some((b) => b.bookUrl === url) } : null;
  if (!data) {
    try {
      data = await api(`/detail?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(origin)}`);
    } catch (e) {
      $('#detail-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
  }

  const b = data.book;
  const inShelf = data.inShelf;
  const cover = b.coverUrl ? `<img src="${esc(coverSrc(b.coverUrl, b.bookUrl))}" onerror="this.remove()" />` : `<span class="ph">${esc((b.name || '?').slice(0, 1))}</span>`;

  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <div class="detail-cover">${cover}</div>
      <div class="detail-meta">
        <h2>${esc(b.name || '未知书名')}</h2>
        <div class="line">${esc(b.author || '未知作者')}</div>
        ${b.kind ? `<div class="line">${esc(b.kind)}</div>` : ''}
        ${b.lastChapter ? `<div class="line">最新：${esc(b.lastChapter)}</div>` : ''}
        <div class="line">来源：${esc(b.originName || b.origin || '未知')}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn ${inShelf ? 'primary' : 'primary'}" id="detail-add">${inShelf ? '开始阅读' : '加入书架'}</button>
      <button class="btn" id="detail-download" ${inShelf ? '' : 'disabled'}>下载 TXT</button>
    </div>
    <div class="section" style="margin:12px 14px">
      <h3>简介</h3>
      <div class="detail-intro" id="detail-intro">${esc(b.intro || '暂无简介')}</div>
      ${b.intro ? '' : '<button class="btn" id="fetch-intro" style="margin-top:8px;padding:6px 12px;font-size:12px">从其它书源 / 晋江获取简介</button>'}
    </div>`;

  $('#detail-add').onclick = async () => {
    if (inShelf) {
      location.hash = '#/read?url=' + encodeURIComponent(url);
      return;
    }
    const btn = $('#detail-add');
    await addBook(b, btn);
    btn.textContent = '开始阅读';
    btn.onclick = () => (location.hash = '#/read?url=' + encodeURIComponent(url));
    $('#detail-download').disabled = false;
  };

  $('#detail-download').onclick = () => startDownloadFlow(url, b.name);

  const fetchBtn = $('#fetch-intro');
  if (fetchBtn)
    fetchBtn.onclick = async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = '获取中…';
      try {
        const r = await api('/intro?name=' + encodeURIComponent(b.name) + '&author=' + encodeURIComponent(b.author || ''));
        if (!r.intro) {
          fetchBtn.disabled = false;
          fetchBtn.textContent = '没找到，重试';
          return;
        }
        b.intro = r.intro;
        $('#detail-intro').textContent = r.intro;
        fetchBtn.remove();
        const tip = document.createElement('div');
        tip.className = 'desc';
        tip.style.cssText = 'font-size:11.5px;color:var(--text-2);margin-top:8px';
        tip.textContent = '简介来源：' + (r.source || '未知') + (r.url ? ' · ' + r.url : '');
        $('#detail-intro').after(tip);
      } catch (e) {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '获取失败，重试';
        toast('获取简介失败：' + e.message);
      }
    };
}

function renderSearchResults() {
  const box = $('#results');
  if (!box) return;
  if (!state.search.results.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = state.search.results
    .map(
      (item, i) => `
    <div class="result" data-i="${i}">
      <div class="thumb">${item.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(item.coverUrl, item.bookUrl))}" onerror="this.remove()" />` : ''}</div>
      <div class="info">
        <div class="title">${esc(item.name)}</div>
        <div class="line2">${esc(item.author || '未知作者')}${item.kind ? ' · ' + esc(item.kind) : ''}</div>
        <div class="line2">${item.lastChapter ? '最新：' + esc(item.lastChapter) : esc(item.intro || '')}</div>
        <div class="actions">
          <span class="tag">${esc(item.originName || '')}</span>${item.viaPhone ? '<span class="tag" style="background:var(--accent-soft);color:var(--accent)">📱 手机解析</span>' : ''}
          <button class="btn primary add" data-i="${i}" style="margin-left:auto;padding:5px 12px;font-size:13px">加入书架</button>
        </div>
      </div>
    </div>`
    )
    .join('');

  box.onclick = async (e) => {
    const btn = e.target.closest('.add');
    if (btn) {
      e.stopPropagation();
      const book = state.search.results[Number(btn.dataset.i)];
      await addBook(book, btn);
      return;
    }
    const row = e.target.closest('.result');
    if (!row) return;
    const item = state.search.results[Number(row.dataset.i)];
    if (!item) return;
    state.detail = item;
    location.hash =
      '#/detail?url=' + encodeURIComponent(item.bookUrl) + '&origin=' + encodeURIComponent(item.origin || '');
  };
}

async function addBook(book, btn) {
  btn.disabled = true;
  btn.textContent = '添加中…';
  try {
    await api('/books', { method: 'POST', body: book });
    btn.textContent = '已在书架';
    toast('已加入书架，正在获取目录…');
    // 后台拉目录，失败不影响加入
    fetch('./api/toc?url=' + encodeURIComponent(book.bookUrl))
      .then((r) => r.json())
      .then((d) => {
        if (d.chapters) toast(`《${book.name}》共 ${d.chapters.length} 章`);
      })
      .catch(() => {});
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '加入书架';
    toast('添加失败：' + e.message);
  }
}

function startSearch(key, opts = {}) {
  if (!key) return toast('请输入关键字');
  if (state.search.running) return toast('正在搜索中…');
  state.search.key = key;
  state.search.results = [];
  state.search.cachedTotal = 0;
  state.search.running = true;
  renderSearchResults();

  const status = $('#search-status');
  const ids = [...state.search.selected];
  const params = new URLSearchParams({ key });
  if (ids.length) params.set('sources', ids.join(','));
  else if (state.search.onlyChecked) params.set('only', 'checked');
  else if (state.search.group) params.set('group', state.search.group);
  if (opts.auto === false) params.set('auto', '0');
  if (state.search.remote) params.set('remote', '1');
  const hint = $('#academic-hint');
  if (hint) hint.style.display = 'none';
  status.innerHTML = `<span class="spinner"></span> 正在搜索…`;
  const goBtn = $('#go');
  if (goBtn) {
    goBtn.textContent = '停止';
    goBtn.classList.remove('primary');
    goBtn.onclick = stopSearch;
  }

  const es = new EventSource('./api/search?' + params.toString());
  state.search.es = es;
  let done = 0;
  let total = 0;

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'start') {
      total = msg.total;
      status.innerHTML = `<span class="spinner"></span> 搜索 ${total} 个书源…`;
    } else if (msg.type === 'academic') {
      const h = $('#academic-hint');
      if (h) {
        h.style.display = 'block';
        h.innerHTML = `🎓 识别为学术查询${msg.hits && msg.hits.length ? '（' + msg.hits.map(esc).join('、') + '）' : ''}，只搜 ${msg.total} 个学术书源　<a href="javascript:void 0" id="acad-all" style="color:var(--accent)">改搜全部</a>`;
        const a = $('#acad-all');
        if (a) a.onclick = () => startSearch(state.search.key, { auto: false });
      }
    } else if (msg.type === 'source-start') {
      status.innerHTML = `<span class="spinner"></span> ${done}/${total || '?'} · 正在搜索：${esc(msg.source)}`;
    } else if (msg.type === 'result') {
      const fresh = msg.books.filter((b) => !state.search.results.some((x) => x.bookUrl === b.bookUrl));
      if (msg.via === 'phone') fresh.forEach((b) => (b.viaPhone = true));
      state.search.results.push(...fresh);
      renderSearchResults();
    } else if (msg.type === 'source-done') {
      if (msg.cachedTotal) state.search.cachedTotal = msg.cachedTotal;
      done = msg.done || done + 1;
      if (msg.total) total = msg.total;
      const cacheNote = msg.cachedTotal ? `（其中 ${msg.cachedTotal} 个命中缓存）` : '';
      status.textContent = `已搜索 ${done}/${total || '?'} 个书源${cacheNote}，找到 ${state.search.results.length} 本`;
    } else if (msg.type === 'done') {
      status.textContent = state.search.results.length
        ? `搜索完成：${state.search.results.length} 本（${total} 个书源${state.search.cachedTotal ? '，' + state.search.cachedTotal + ' 个命中缓存' : ''}）`
        : '没有找到结果：可能是书源失效，或该源需要 WebView/加密接口。可在「书源」里只选几个源重试';
      finishSearch();
    } else if (msg.type === 'error') {
      status.textContent = msg.message;
      finishSearch();
    }
  };
  es.onerror = () => {
    if (state.search.running) {
      status.textContent = '搜索连接中断';
      finishSearch();
    }
  };
}

function stopSearch() {
  finishSearch();
  const st = $('#search-status');
  if (st) st.textContent = `已停止，共找到 ${state.search.results.length} 本`;
}

function finishSearch() {
  state.search.running = false;
  const goBtn = $('#go');
  if (goBtn) {
    goBtn.textContent = '搜索';
    goBtn.classList.add('primary');
    goBtn.onclick = () => {
      const kw = $('#kw');
      if (kw) startSearch(kw.value.trim());
    };
  }
  if (state.search.es) {
    state.search.es.close();
    state.search.es = null;
  }
}

/* ---------------- 阅读器 ---------------- */
async function openReader(bookUrl, wantTitle) {
  if (!bookUrl) return (location.hash = '#/shelf');
  view.innerHTML = `<div class="reader"><div class="empty"><span class="spinner"></span> 正在打开…</div></div>`;
  try {
    if (!Array.isArray(state.books) || !state.books.length) await loadBooks();
    let book = state.books.find((b) => b.bookUrl === bookUrl);
    if (!book) {
      await loadBooks();
      book = state.books.find((b) => b.bookUrl === bookUrl);
    }
    if (!book) throw new Error('书籍不在书架中');
    const { chapters } = await api('/toc?url=' + encodeURIComponent(bookUrl));
    if (!chapters || !chapters.length) throw new Error('目录为空');
    book.chapters = chapters;
    book.totalChapterNum = chapters.length;
    let idx = Math.min(book.durChapterIndex || 0, chapters.length - 1);
    // 换源后按章节标题定位到同一章
    if (wantTitle) {
      const norm = (t) => String(t || '').replace(/\s+/g, '');
      const target = norm(wantTitle);
      const exact = chapters.findIndex((c) => norm(c.title) === target);
      if (exact >= 0) idx = exact;
      else {
        const loose = chapters.findIndex((c) => norm(c.title).includes(target) || target.includes(norm(c.title)));
        if (loose >= 0) idx = loose;
      }
    }
    state.reader = { book, chapters, index: idx };
    renderReaderShell();
    await loadChapter(state.reader.index);
  } catch (e) {
    view.innerHTML = `<div class="reader"><div class="empty">打开失败：${esc(e.message)}<br /><br /><a class="btn" href="#/shelf">返回书架</a></div></div>`;
  }
}

function renderReaderShell() {
  const { book } = state.reader;
  view.innerHTML = `
    <div class="reader kindle">
      <header class="reader-head" id="reader-head">
        <button class="icon-btn" id="back">‹</button>
        <div class="title" id="book-title">${esc(book.name)}</div>
        <button class="icon-btn" id="switch-src" title="换源">⇄</button>
        <button class="icon-btn" id="catalog">☰</button>
        <button class="icon-btn" id="reader-settings">Aa</button>
      </header>
      <main class="article-wrap">
        <article class="article" id="article"></article>
      </main>
      <footer class="reader-foot" id="reader-foot">
        <button class="foot-btn" id="prev">‹ 上一章</button>
        <span class="foot-info" id="foot-info"></span>
        <button class="foot-btn" id="next">下一章 ›</button>
        <span class="foot-progress"><i id="foot-progress-bar"></i></span>
      </footer>
    </div>
    <div class="drawer hidden" id="drawer">
      <div class="mask" id="drawer-mask"></div>
      <div class="panel">
        <div class="drawer-head">
          <h3 id="drawer-title">目录</h3>
          <span class="drawer-sub" id="drawer-sub"></span>
        </div>
        <div class="list" id="chapter-list"></div>
      </div>
    </div>`;

  $('#back').onclick = () => (location.hash = '#/shelf');
  $('#switch-src').onclick = openSwitchSource;
  $('#catalog').onclick = toggleDrawer;
  $('#drawer-mask').onclick = toggleDrawer;
  $('#prev').onclick = () => gotoChapter(state.reader.index - 1);
  $('#next').onclick = () => gotoChapter(state.reader.index + 1);
  $('#reader-settings').onclick = openReaderSettings;

  const list = $('#chapter-list');
  list.innerHTML = state.reader.chapters
    .map((c, i) => `<div class="item" data-i="${i}"><span class="no">${i + 1}</span>${esc(c.title)}</div>`)
    .join('');
  list.onclick = (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    toggleDrawer();
    gotoChapter(Number(item.dataset.i));
  };

  const sub = $('#drawer-sub');
  if (sub) sub.textContent = `共 ${state.reader.chapters.length} 章`;
}

function toggleDrawer() {
  const d = $('#drawer');
  if (!d) return;
  d.classList.toggle('hidden');
  if (!d.classList.contains('hidden')) {
    const on = $('#chapter-list .item.on');
    if (on) on.scrollIntoView({ block: 'center' });
  }
}

async function loadChapter(index) {
  const r = state.reader;
  if (!r) return;
  if (index < 0 || index >= r.chapters.length) return;
  r.index = index;
  const article = $('#article');
  article.innerHTML = `<div class="loading"><span class="spinner"></span> 正在加载…</div>`;
  $$('#chapter-list .item').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === index));
  $('#prev').disabled = index === 0;
  $('#next').disabled = index >= r.chapters.length - 1;
  updateReaderMeta();

  const data = await api(`/content?url=${encodeURIComponent(r.book.bookUrl)}&index=${index}`).catch((e) => ({ error: e.message }));
  if (r.index !== index) return;
  if (data.error) {
    article.innerHTML = `<div class="loading">加载失败：${esc(data.error)}</div>`;
    return;
  }
  article.innerHTML = '';
  const h = document.createElement('h2');
  h.className = 'chapter-head';
  h.textContent = r.chapters[index].title;
  article.appendChild(h);
  for (const p of data.paragraphs) {
    const el = document.createElement('p');
    el.textContent = p;
    article.appendChild(el);
  }
  updateReaderMeta();
  window.scrollTo(0, 0);
  saveProgress();
}

/** 顶部书名、底部进度、进度条 */
function updateReaderMeta() {
  const r = state.reader;
  if (!r) return;
  const total = r.chapters.length || 1;
  const pct = Math.round(((r.index + 1) / total) * 100);
  const bt = $('#book-title');
  if (bt) bt.textContent = r.book.name;
  const info = $('#foot-info');
  if (info) info.textContent = `${r.index + 1} / ${total} · ${pct}%`;
  const bar = $('#foot-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

function gotoChapter(index) {
  const r = state.reader;
  if (!r || index < 0 || index >= r.chapters.length) return;
  if (state.reader.index === index) return;
  loadChapter(index);
}

let progressTimer;
function saveProgress() {
  const r = state.reader;
  if (!r) return;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    api('/progress', {
      method: 'POST',
      body: { bookUrl: r.book.bookUrl, index: r.index, pos: 0, title: r.chapters[r.index].title },
    }).catch(() => {});
    const shelfBook = state.books.find((b) => b.bookUrl === r.book.bookUrl);
    if (shelfBook) {
      shelfBook.durChapterIndex = r.index;
      shelfBook.durChapterTitle = r.chapters[r.index].title;
    }
  }, 600);
}

async function openSwitchSource() {
  const r = state.reader;
  if (!r) return;
  const modal = $('#modal');
  const box = $('#modal-box');
  const curTitle = r.chapters[r.index] ? r.chapters[r.index].title : '';
  box.innerHTML = `
    <h3 style="margin-bottom:6px">换源</h3>
    <div class="desc" style="font-size:12px;color:var(--text-2);margin-bottom:10px">
      按书名「${esc(r.book.name)}」重新搜索，当前进度：${esc(curTitle)}
    </div>
    <div id="switch-list" style="max-height:56vh;overflow:auto"><div class="empty"><span class="spinner"></span> 搜索中…</div></div>
    <div class="modal-actions"><button class="btn" id="switch-close">关闭</button></div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#switch-close').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  let data;
  try {
    data = await api(
      `/switch-source?name=${encodeURIComponent(r.book.name)}&exclude=${encodeURIComponent(r.book.bookUrl)}&limit=10`
    );
  } catch (e) {
    $('#switch-list').innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
    return;
  }

  if (!data.books.length) {
    $('#switch-list').innerHTML = '<div class="empty">没有找到其它书源的同名书</div>';
    return;
  }

  $('#switch-list').innerHTML = data.books
    .map(
      (b, i) => `
      <div class="switch-item" data-i="${i}">
        <div class="switch-cover">${b.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(b.coverUrl, b.bookUrl))}" onerror="this.remove()" />` : `<span class="ph">${esc((b.name || '?').slice(0, 1))}</span>`}</div>
        <div class="switch-meta">
          <b>${esc(b.name)}</b>
          <div class="desc">${esc(b.author || '未知作者')} · ${esc(b.originName || '')}</div>
          <div class="desc">${esc(b.lastChapter ? '最新：' + b.lastChapter : '')}</div>
        </div>
        <button class="btn primary" data-pick="${i}" style="padding:6px 12px;font-size:12px">切到这本</button>
      </div>`
    )
    .join('');

  $('#switch-list').onclick = async (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const b = data.books[Number(btn.dataset.pick)];
    if (!b) return;
    btn.disabled = true;
    btn.textContent = '切换中…';
    try {
      await api('/books/switch', { method: 'POST', body: { fromUrl: r.book.bookUrl, book: b } });
      await loadBooks();
      close();
      location.hash =
        '#/read?url=' + encodeURIComponent(b.bookUrl) + '&title=' + encodeURIComponent(curTitle);
    } catch (err) {
      toast('换源失败：' + err.message);
      btn.disabled = false;
      btn.textContent = '切到这本';
    }
  };
}

function openReaderSettings() {
  const cfg = state.config;
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>阅读设置</h3>
    <div class="row"><div class="label">主题</div>
      <div class="seg" id="seg-theme">
        ${['light', 'sepia', 'dark'].map((t) => `<button data-v="${t}" class="${cfg.theme === t ? 'on' : ''}">${{ light: '浅色', sepia: '羊皮纸', dark: '深色' }[t]}</button>`).join('')}
      </div>
    </div>
    <div class="row"><div class="label">字号 <span class="desc">${cfg.fontSize}px</span></div>
      <div class="seg">
        <button data-font="-1">A-</button><button data-font="1">A+</button>
      </div>
    </div>
    <div class="row"><div class="label">行距</div>
      <div class="seg">
        <button data-lh="-0.1">紧</button><button data-lh="0.1">松</button>
      </div>
    </div>
    <div class="row" style="border-top:1px solid var(--line)">
      <div class="label">整本下载<div class="desc">抓取全部章节，合并为一个 TXT</div></div>
      <button class="btn" id="dl-book">下载</button>
    </div>
    <div class="modal-actions"><button class="btn primary" id="modal-close">完成</button></div>`;

  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#modal-close').onclick = close;
  const dlBtn = $('#dl-book');
  if (dlBtn)
    dlBtn.onclick = () => {
      close();
      const b = state.reader && state.reader.book;
      if (b) startDownloadFlow(b.bookUrl, b.name);
    };
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  $('#seg-theme').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    saveConfig({ theme: b.dataset.v });
    $$('#seg-theme button').forEach((x) => x.classList.toggle('on', x === b));
  };
  box.querySelectorAll('[data-font]').forEach((b) => {
    b.onclick = () => {
      const v = Math.max(14, Math.min(30, cfg.fontSize + Number(b.dataset.font)));
      saveConfig({ fontSize: v });
      box.querySelector('.row .desc').textContent = v + 'px';
    };
  });
  box.querySelectorAll('[data-lh]').forEach((b) => {
    b.onclick = () => {
      const v = Math.max(1.3, Math.min(2.6, Math.round((cfg.lineHeight + Number(b.dataset.lh)) * 100) / 100));
      saveConfig({ lineHeight: v });
    };
  });
}

/* ---------------- 书源管理 ---------------- */
const CHECK_LABEL = { ok: '可用', empty: '无结果', fail: '不可用' };
let checkTimer = null;

const sourceUI = { select: false, picked: new Set() };

function sourceRow(s) {
  const st = s.checkStatus || '';
  const dot = st === 'ok' ? '#34c759' : st === 'empty' ? '#9a9aa0' : st === 'fail' ? '#ff3b30' : 'rgba(128,128,128,0.25)';
  const picked = sourceUI.picked.has(s.bookSourceUrl);
  const left = sourceUI.select
    ? `<span class="cb ${picked ? 'on' : ''}" data-check="1">${picked ? '✓' : ''}</span>`
    : `<span style="width:8px;height:8px;border-radius:50%;flex:none;background:${dot}"></span>`;
  const right = sourceUI.select
    ? ''
    : `<div class="switch ${s.enabled ? 'on' : ''}" data-toggle="1"></div>
       <button class="btn ghost" data-del="1" style="padding:6px 8px;color:var(--danger)">删除</button>`;
  return `<div class="source-item ${picked ? 'picked' : ''}" data-id="${esc(s.bookSourceUrl)}">
    ${left}
    <div class="name"><b>${esc(s.bookSourceName)}</b><span>${esc(s.bookSourceUrl)}${s.bookSourceGroup ? ' · ' + esc(s.bookSourceGroup) : ''}${st ? ' · ' + CHECK_LABEL[st] : ''}</span></div>
    ${right}
  </div>`;
}

function renderSourceList(filter = '') {
  const box = $('#source-list');
  if (!box) return;
  const list = state.sources.filter(
    (s) => !filter || (s.bookSourceName + ' ' + s.bookSourceUrl + ' ' + (s.bookSourceGroup || '')).toLowerCase().includes(filter)
  );
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有匹配的书源</div>';
    return;
  }
  // 按书源分组展示，避免几百个源堆成一条长列表
  const groups = new Map();
  for (const s of list) {
    const g = s.bookSourceGroup || '未分组';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  box.innerHTML = sorted
    .map(
      ([g, arr], i) => `<details class="section" style="margin-top:10px" ${filter || i === 0 || sourceUI.select ? 'open' : ''}>
        <summary style="padding:12px 16px;cursor:pointer;font-size:13px;color:var(--text-2);list-style:none;display:flex;align-items:center;gap:8px">
          <span style="flex:1">${esc(g)}</span>
          <span>${arr.length} 个</span>
        </summary>
        ${arr.map(sourceRow).join('')}
      </details>`
    )
    .join('');
  renderBulkBar();
}

function renderBulkBar() {
  let bar = $('#source-bulk');
  if (!sourceUI.select) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'source-bulk';
    bar.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(var(--tabbar-h) + 12px);z-index:55;' +
      'display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);' +
      'border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:13px';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span style="flex:1">已选 <b>${sourceUI.picked.size}</b> 个</span>
    <button class="btn" id="bulk-all" style="padding:6px 10px;font-size:12px">全选</button>
    <button class="btn" id="bulk-none" style="padding:6px 10px;font-size:12px">清空</button>
    <button class="btn" id="bulk-del" style="padding:6px 10px;font-size:12px;background:var(--danger);color:#fff;border-color:transparent">删除</button>`;
  const all = () => {
    sourceUI.picked.clear();
    state.sources.forEach((s) => sourceUI.picked.add(s.bookSourceUrl));
    renderSourceList($('#src-filter') ? $('#src-filter').value.trim().toLowerCase() : '');
  };
  $('#bulk-all').onclick = all;
  $('#bulk-none').onclick = () => {
    sourceUI.picked.clear();
    renderSourceList($('#src-filter') ? $('#src-filter').value.trim().toLowerCase() : '');
  };
  $('#bulk-del').onclick = async () => {
    const urls = [...sourceUI.picked];
    if (!urls.length) return toast('还没有选择书源');
    if (!confirm(`删除选中的 ${urls.length} 个书源？\n（会先备份到应用数据目录的 backup/）`)) return;
    try {
      const r = await api('/sources/batch-delete', { method: 'POST', body: { urls } });
      toast(`已删除 ${r.removed} 个，剩余 ${r.remaining} 个`);
      sourceUI.picked.clear();
      sourceUI.select = false;
      renderSources();
    } catch (e) {
      toast('删除失败：' + e.message);
    }
  };
}

async function renderSources() {
  // 支持 #/sources?manage=1 直接进入多选模式
  if (parseHash().params.get('manage') === '1') sourceUI.select = true;
  view.innerHTML = `
    <header class="topbar"><h1>书源</h1>
      <button class="btn" id="check-src">检测</button>
      <button class="btn" id="manage-src">${sourceUI.select ? '完成' : '管理'}</button>
      <button class="btn primary" id="import">导入</button>
    </header>
    <div class="progress-line" id="check-line"></div>
    <div class="searchbar" style="padding:0 14px 6px"><input id="src-filter" placeholder="筛选书源（名称 / 地址）" /></div>
    <div id="source-list"><div class="empty">加载中…</div></div>`;

  $('#import').onclick = openImport;
  $('#check-src').onclick = startSourceCheck;
  $('#manage-src').onclick = () => {
    sourceUI.select = !sourceUI.select;
    sourceUI.picked.clear();
    renderSources();
  };
  $('#src-filter').oninput = (e) => renderSourceList(e.target.value.trim().toLowerCase());

  try {
    const { sources } = await api('/sources');
    state.sources = sources;
    if (!sources.length) {
      sourceUI.select = false;
      sourceUI.picked.clear();
      renderBulkBar();
      $('#source-list').innerHTML = `<div class="empty"><div class="big">🧩</div>还没有书源<br />支持粘贴 Legado 书源 JSON、书源链接，或导入 .json 文件</div>`;
      return;
    }
    renderSourceList();
    renderCheckBar();
    $('#source-list').onclick = async (e) => {
      const item = e.target.closest('.source-item');
      if (!item) return;
      const id = item.dataset.id;
      const src = state.sources.find((s) => s.bookSourceUrl === id);
      if (!src) return;

      // 多选模式：整行点击切换勾选
      if (sourceUI.select) {
        if (sourceUI.picked.has(id)) sourceUI.picked.delete(id);
        else sourceUI.picked.add(id);
        renderSourceList($('#src-filter') ? $('#src-filter').value.trim().toLowerCase() : '');
        return;
      }

      if (e.target.dataset.toggle) {
        const enabled = !(src.enabled !== false);
        await api('/sources/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled } });
        src.enabled = enabled;
        e.target.classList.toggle('on', enabled);
      } else if (e.target.dataset.del) {
        if (!confirm(`删除书源「${src.bookSourceName}」？`)) return;
        await api('/sources/' + encodeURIComponent(id), { method: 'DELETE' });
        renderSources();
      }
    };
  } catch (e) {
    $('#source-list').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

function renderCheckBar(st) {
  const line = $('#check-line');
  if (!line) return;
  const checked = state.sources.filter((s) => s.checkStatus);
  const ok = state.sources.filter((s) => s.checkStatus === 'ok').length;
  if (st && st.running) {
    line.innerHTML = `<span class="spinner"></span> 检测中 ${st.done}/${st.total} · 可用 ${st.ok} · 无结果 ${st.empty} · 失败 ${st.fail}`;
    return;
  }
  if (checked.length) {
    line.innerHTML = `已检测 ${checked.length} 个 · 可用 <b style="color:var(--accent)">${ok}</b> 个
      <button class="btn" id="disable-bad" style="margin-left:8px;padding:4px 10px;font-size:12px">停用未通过</button>`;
    const btn = $('#disable-bad');
    if (btn)
      btn.onclick = async () => {
        if (!confirm('将停用所有「不可用 / 无结果」的书源，只保留可用书源。继续？')) return;
        const r = await api('/sources/check/disable-unavailable', { method: 'POST' });
        toast(`已停用 ${r.disabled} 个书源`);
        renderSources();
      };
  } else {
    line.textContent = '书源很多时建议先「检测」，会自动标记哪些能用';
  }
}

async function startSourceCheck() {
  const filter = ($('#src-filter')?.value || '').trim().toLowerCase();
  const visible = state.sources.filter(
    (s) => !filter || (s.bookSourceName + ' ' + s.bookSourceUrl + ' ' + (s.bookSourceGroup || '')).toLowerCase().includes(filter)
  );
  if (!visible.length) return toast('没有可检测的书源');
  if (!confirm(`将检测当前列表里的 ${visible.length} 个书源，可能耗时较久，继续？`)) return;
  const key = prompt('用哪个关键字检测书源？建议用热门书名', '斗破') || '';
  if (!key.trim()) return;
  try {
    const r = await api('/sources/check', {
      method: 'POST',
      body: { key: key.trim(), ids: visible.map((s) => s.bookSourceUrl) },
    });
    if (!r.started && !r.running) return toast('检测启动失败');
    toast('开始检测书源，可能需要几分钟');
  } catch (e) {
    return toast('检测失败：' + e.message);
  }
  clearInterval(checkTimer);
  const poll = async () => {
    try {
      const st = await api('/sources/check');
      renderCheckBar(st);
      if (!st.running) {
        clearInterval(checkTimer);
        const { sources } = await api('/sources');
        state.sources = sources;
        renderSourceList($('#src-filter') ? $('#src-filter').value.trim().toLowerCase() : '');
        renderCheckBar(st);
        toast(`检测完成：可用 ${st.ok} 个`);
      }
    } catch {
      clearInterval(checkTimer);
    }
  };
  poll();
  checkTimer = setInterval(poll, 2500);
}

function openImport() {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>导入书源</h3>
    <p class="desc" style="color:var(--text-2);font-size:13px;margin:0 0 10px">
      支持 Legado 书源 JSON（数组或单个对象），也可以填入书源订阅链接。
    </p>
    <textarea class="import" id="import-text" placeholder='[{"bookSourceName":"示例","bookSourceUrl":"https://..."}]'></textarea>
    <div class="row" style="padding:12px 0 0;border:0">
      <input type="file" id="import-file" accept=".json,application/json" style="font-size:13px" />
    </div>
    <div class="row" style="padding:10px 0 0;border:0">
      <input id="import-url" placeholder="https://example.com/sources.json" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg);outline:none" />
    </div>
    <div class="modal-actions">
      <button class="btn" id="import-cancel">取消</button>
      <button class="btn primary" id="import-ok">导入</button>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#import-cancel').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  $('#import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#import-text').value = await file.text();
  };
  $('#import-ok').onclick = async () => {
    const text = $('#import-text').value.trim();
    const url = $('#import-url').value.trim();
    try {
      if (text) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error('JSON 格式不正确');
        }
        const sources = Array.isArray(parsed) ? parsed : [parsed];
        const r = await api('/sources', { method: 'POST', body: { sources } });
        toast(`已导入 ${r.imported} 个书源`);
      } else if (url) {
        const r = await api('/sources', { method: 'POST', body: { url } });
        toast(`已导入 ${r.imported} 个书源`);
      } else {
        return toast('请粘贴书源内容或填写链接');
      }
      close();
      renderSources();
    } catch (e) {
      toast('导入失败：' + e.message);
    }
  };
}

/* ---------------- 订阅 ---------------- */
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderFeeds() {
  view.innerHTML = `
    <header class="topbar"><h1>搜索</h1>
      <button class="btn" id="feed-refresh-all">刷新</button>
      <button class="btn primary" id="feed-add">添加</button>
    </header>
    <div class="chips" id="mode-row" style="padding-bottom:0">
      <button class="chip" data-mode="book">找书</button>
      <button class="chip on" data-mode="feed">订阅</button>
    </div>
    <div id="feeds-body"><div class="empty">加载中…</div></div>`;

  $('#mode-row').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.mode === 'book') location.hash = '#/search';
  };

  $('#feed-add').onclick = openAddFeed;
  $('#feed-refresh-all').onclick = async () => {
    toast('正在刷新订阅…');
    try {
      const { feeds } = await api('/feeds');
      for (const f of feeds) await api('/feeds', { method: 'POST', body: { refresh: f.id } }).catch(() => {});
      toast('订阅已刷新');
      renderFeeds();
    } catch (e) {
      toast('刷新失败：' + e.message);
    }
  };

  try {
    const { feeds } = await api('/feeds');
    const body = $('#feeds-body');
    if (!feeds.length) {
      body.innerHTML = `<div class="empty"><div class="big">📡</div>还没有订阅<br />添加 RSS / Atom 地址即可，例如博客、新闻、连载更新</div>`;
      return;
    }
    if (!Array.isArray(state.books) || !state.books.length) await loadBooks();
    const feedBook = (url) => state.books.find((b) => b.bookUrl === 'feed://' + url);

    body.innerHTML = feeds
      .map(
        (f) => {
        const book = feedBook(f.url);
        return `
      <div class="section" style="margin:12px 14px">
        <div class="row" style="align-items:flex-start">
          <div class="label">
            <b>${esc(f.title)}</b>
            <div class="desc">${esc(f.url)} · ${f.items.length} 条${book ? ' · 书架中 ' + (book.totalChapterNum || (Array.isArray(book.chapters) ? book.chapters.length : 0)) + ' 章' : ''} · ${formatDate(f.fetchedAt)}</div>
          </div>
          <button class="btn ${book ? '' : 'primary'}" data-add="${esc(f.id)}" style="padding:5px 10px;font-size:12px">${book ? '已在书架' : '加入书架'}</button>
          <button class="btn" data-refresh="${esc(f.id)}" style="padding:5px 10px;font-size:12px">刷新</button>
          <button class="btn" data-del="${esc(f.id)}" style="padding:5px 10px;font-size:12px;color:var(--danger)">删除</button>
        </div>
        ${f.items
          .slice(0, 30)
          .map(
            (it) =>
              `<a class="feed-item" href="${esc(it.link || '#')}" target="_blank" rel="noopener">
                 <div class="feed-title">${esc(it.title)}</div>
                 <div class="feed-meta">${formatDate(it.date)}</div>
               </a>`
          )
          .join('')}
      </div>`;
        }
      )
      .join('');

    body.onclick = async (e) => {
      const ref = e.target.dataset.refresh;
      const del = e.target.dataset.del;
      const add = e.target.dataset.add;
      if (add) {
        e.preventDefault();
        const f = feeds.find((x) => x.id === add);
        const existing = f ? feedBook(f.url) : null;
        if (existing) {
          location.hash = '#/read?url=' + encodeURIComponent(existing.bookUrl);
          return;
        }
        try {
          const r = await api('/feeds/to-book', { method: 'POST', body: { id: add } });
          toast(r.added ? `已加入书架，合并 ${r.added} 条` : '已在书架');
          await loadBooks();
          renderFeeds();
        } catch (err) {
          toast('加入失败：' + err.message);
        }
        return;
      }
      if (ref) {
        e.preventDefault();
        toast('刷新中…');
        try {
          await api('/feeds', { method: 'POST', body: { refresh: ref } });
          renderFeeds();
        } catch (err) {
          toast('刷新失败：' + err.message);
        }
      } else if (del) {
        e.preventDefault();
        if (!confirm('删除这个订阅？')) return;
        await api('/feeds?id=' + encodeURIComponent(del), { method: 'DELETE' });
        renderFeeds();
      }
    };
  } catch (e) {
    $('#feeds-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

function openAddFeed() {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>添加订阅</h3>
    <p style="color:var(--text-2);font-size:13px;margin:0 0 10px">支持 RSS 2.0 / Atom 地址</p>
    <input id="feed-url" placeholder="https://example.com/feed.xml"
      style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--bg);outline:none" />
    <div class="modal-actions">
      <button class="btn" id="feed-cancel">取消</button>
      <button class="btn primary" id="feed-ok">添加</button>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#feed-cancel').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  $('#feed-ok').onclick = async () => {
    const url = $('#feed-url').value.trim();
    if (!url) return toast('请输入订阅地址');
    try {
      await api('/feeds', { method: 'POST', body: { url } });
      close();
      toast('订阅已添加');
      renderFeeds();
    } catch (e) {
      toast('添加失败：' + e.message);
    }
  };
}

/* ---------------- 已下载 ---------------- */
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function renderDownloads() {
  view.innerHTML = `
    <header class="topbar"><h1>已下载</h1><a class="btn ghost" href="#/settings">设置</a></header>
    <div id="dl-body"><div class="empty">加载中…</div></div>`;
  try {
    const { items } = await api('/downloads');
    const body = $('#dl-body');
    if (!items.length) {
      body.innerHTML = `<div class="empty"><div class="big">📥</div>还没有下载过书籍<br />在书架长按书封，选「下载整本为 TXT」</div>`;
      return;
    }
    body.innerHTML = `<div class="section" style="margin-top:12px">${items
      .map(
        (it) => `<div class="source-item">
        <div class="name">
          <b>${esc(it.name)}</b>
          <span>${esc(it.author || '')} · ${it.chapters} 章 · ${formatSize(it.size)} · ${formatDate(it.time)}${it.exists ? '' : ' · 文件已丢失'}</span>
          <span style="color:var(--text-2)">${esc(String(it.file || '').replace(/\/[^/]*$/, '') || '')}</span>
        </div>
        ${
          it.exists
            ? `<a class="btn" download style="padding:6px 10px;font-size:12px" href="./api/download/file?url=${encodeURIComponent(it.bookUrl)}">保存</a>`
            : ''
        }
        <button class="btn ghost" data-del="${esc(it.bookUrl)}" style="padding:6px 8px;color:var(--danger);font-size:12px">删除</button>
      </div>`
      )
      .join('')}</div>`;
    body.onclick = async (e) => {
      const bookUrl = e.target.dataset.del;
      if (!bookUrl) return;
      if (!confirm('删除这本书的 TXT 文件？')) return;
      try {
        await api('/downloads?url=' + encodeURIComponent(bookUrl), { method: 'DELETE' });
        toast('已删除');
        renderDownloads();
      } catch (err) {
        toast('删除失败：' + err.message);
      }
    };
  } catch (e) {
    $('#dl-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------------- 使用帮助 ---------------- */
const HELP_KEY = 'legado-help-v1';

function showHelp(manual = false) {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3 style="margin-bottom:2px">欢迎使用 阅读</h3>
    <p style="color:var(--text-2);font-size:12.5px;margin:0 0 6px">在飞牛里读书 · 兼容 Legado 3.x 书源</p>

    <div class="help-item">
      <div class="help-ico">书</div>
      <div><b>书架</b><p>点封面继续阅读；点右上角「⋯」或长按封面可下载整本 TXT、刷新目录、从书架删除。</p></div>
    </div>
    <div class="help-item">
      <div class="help-ico">搜</div>
      <div><b>搜索（找书 / 订阅）</b><p>「找书」按书名或作者搜，可只搜「仅可用」书源，也能按分组搜；「订阅」添加 RSS / Atom 地址。</p></div>
    </div>
    <div class="help-item">
      <div class="help-ico">源</div>
      <div><b>书源</b><p>粘贴或导入 Legado 书源 JSON。书源很多时先点「检测」，跑完点「停用未通过」，之后搜索会快很多。</p></div>
    </div>
    <div class="help-item">
      <div class="help-ico">设</div>
      <div><b>设置</b><p>阅读主题 / 字号 / 行距；下载位置（可选 fnOS 授权目录）、已下载书籍列表。</p></div>
    </div>
    <div class="help-item">
      <div class="help-ico">读</div>
      <div><b>阅读页</b><p>底部「上一章 / 下一章」翻页；右上角「☰」是目录、「Aa」调主题和字号，整本下载也在里面。进度自动保存。</p></div>
    </div>

    <div class="modal-actions">
      <button class="btn primary" id="help-ok">知道了</button>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => {
    modal.classList.add('hidden');
    try {
      localStorage.setItem(HELP_KEY, '1');
    } catch {
      /* 隐私模式下可能不可写 */
    }
  };
  $('#help-ok').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
}

function maybeShowFirstRunHelp() {
  if (parseHash().params.get('log') === '1') return;
  if (parseHash().params.get('help') === '0') return;
  let seen = false;
  try {
    seen = localStorage.getItem(HELP_KEY) === '1';
  } catch {
    seen = true;
  }
  if (!seen)
    setTimeout(() => {
      const m = $('#modal');
      // 已经有别的弹窗（比如更新日志）就先不打扰
      if (m && !m.classList.contains('hidden')) return;
      showHelp();
    }, 400);
}

/* ---------------- 更新日志 ---------------- */
async function showChangelog() {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3 style="margin-bottom:10px">更新日志</h3>
    <div id="log-body" style="max-height:60vh;overflow:auto;font-size:12.5px;color:var(--text-2)">正在加载…</div>
    <div class="modal-actions">
      <a class="btn" href="./docs/changelog.txt" target="_blank" rel="noopener">纯文本版</a>
      <button class="btn primary" id="log-ok">关闭</button>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#log-ok').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  // 直接读安装包里随附的更新日志，避免应用内写死一份、发版后忘记同步
  try {
    const res = await fetch('./docs/changelog.txt?v=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const body = $('#log-body');
    if (body) {
      body.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;line-height:1.75;margin:0;color:var(--text-2)">${esc(text)}</pre>`;
    }
  } catch (e) {
    const body = $('#log-body');
    if (body) body.innerHTML = `<div style="color:var(--danger)">读取更新日志失败：${esc(e.message)}</div>`;
  }
}

/* ---------------- 设置 ---------------- */
async function renderSettings() {
  // 支持 #/settings?log=1 直接打开更新日志
  if (parseHash().params.get('log') === '1') setTimeout(() => showChangelog(), 300);
  view.innerHTML = `
    <header class="topbar"><h1>设置</h1></header>
    <div id="settings-body"><div class="empty">加载中…</div></div>`;
  try {
    const cfg = await api('/config');
    applyConfig(cfg);
    $('#settings-body').innerHTML = `
      <div class="section">
        <h3>阅读</h3>
        <div class="row"><div class="label">主题</div>
          <div class="seg" id="set-theme">
            ${['light', 'sepia', 'dark'].map((t) => `<button data-v="${t}" class="${cfg.theme === t ? 'on' : ''}">${{ light: '浅色', sepia: '羊皮纸', dark: '深色' }[t]}</button>`).join('')}
          </div>
        </div>
        <div class="row"><div class="label">字号</div>
          <input type="number" id="set-font" min="14" max="30" value="${cfg.fontSize}" style="width:72px" />
        </div>
        <div class="row"><div class="label">行距</div>
          <input type="number" id="set-lh" min="1.3" max="2.6" step="0.05" value="${cfg.lineHeight}" style="width:72px" />
        </div>
      </div>
      <div class="section">
        <h3>界面</h3>
        <div class="row"><div class="label">液态玻璃底栏<div class="desc">底栏改为半透明玻璃质感，随主题自动适配</div></div>
          <div class="switch ${cfg.liquidGlass ? 'on' : ''}" id="sw-glass"></div></div>
      </div>
      <div class="section">
        <h3>手机接入</h3>
        <div class="row"><div class="label">接口地址<div class="desc" id="api-base" style="word-break:break-all">-</div></div>
          <button class="btn" id="copy-base" style="padding:5px 10px;font-size:12px">复制</button></div>
        <div class="row"><div class="label">其它地址<div class="desc" id="api-alts" style="word-break:break-all">-</div></div></div>
        <div class="row"><div class="label">访问令牌<div class="desc" id="api-token" style="word-break:break-all">-</div></div>
          <button class="btn" id="copy-token" style="padding:5px 10px;font-size:12px">复制</button>
          <button class="btn ghost" id="reset-token" style="padding:5px 8px;font-size:12px;color:var(--danger)">重置</button></div>
        <div class="row"><div class="label">说明<div class="desc">安卓 App 通过 /api/m/* 读取书架、目录与正文，请求头带 X-Api-Token</div></div></div>
      </div>
      <div class="section">
        <h3>阅读 APK 接入</h3>
        <div class="row"><div class="label">书源导入链接<div class="desc" id="apk-src-link" style="word-break:break-all">-</div></div>
          <button class="btn" id="copy-apk-link" style="padding:5px 10px;font-size:12px">复制</button></div>
        <div class="row"><div class="label">书源 JSON<div class="desc" id="apk-src-json" style="word-break:break-all">-</div></div>
          <button class="btn ghost" id="copy-apk-json" style="padding:5px 10px;font-size:12px">复制</button></div>
        <div class="row"><div class="label">APK<div class="desc"><a id="apk-dl" href="https://github.com/TZYLXS/yuedu-android4/releases" target="_blank">下载「阅读」兼容版 APK（Android 4.4–5.1）</a></div></div></div>
        <div class="row"><div class="label">用法<div class="desc">手机装好 APK 后，复制上面的导入链接，在「阅读」里「我的 → 书源管理 → 网络导入」粘贴即可；之后搜书、目录、正文、封面全部走本机飞牛书库。</div></div></div>
      </div>
      <div class="section">
        <h3>下载</h3>
        <a class="row" href="#/downloads" style="text-decoration:none"><div class="label">已下载书籍<div class="desc" id="stat-dl">-</div></div><span style="color:var(--text-2)">›</span></a>
        <div class="row"><div class="label">保存位置<div class="desc" id="stat-dir">-</div></div>
          <select id="set-dir" style="max-width:46%;font-size:12px"></select>
        </div>
      </div>
      <div class="section">
        <h3>数据</h3>
        <div class="row"><div class="label">书源数量<div class="desc" id="stat-src">-</div></div></div>
        <div class="row"><div class="label">书籍数量<div class="desc" id="stat-book">-</div></div></div>
        <div class="row"><div class="label">搜索缓存<div class="desc" id="stat-cache">-</div></div><button class="btn" id="clear-cache" style="padding:5px 10px;font-size:12px">清空</button></div>
      </div>
      <div class="section">
        <h3>书源</h3>
        <a class="row" href="#/sources" style="text-decoration:none"><div class="label">书源管理<div class="desc" id="src-summary">导入、检测、分组与批量删除</div></div><span style="color:var(--text-2)">›</span></a>
      </div>
      <div class="section">
        <h3>软总线</h3>
        <div class="row"><div class="label">优先手机解析<div class="desc">开启后搜索先交给在线设备，失败再本机解析</div></div>
          <div class="switch ${cfg.preferRemote ? 'on' : ''}" id="sw-prefer"></div></div>
        <a class="row" href="#/bus" style="text-decoration:none"><div class="label">手机解析待命<div class="desc" id="bus-summary">查看哪些设备可以代理解析</div></div><span style="color:var(--text-2)">›</span></a>
      </div>
      <div class="section">
        <h3>屏蔽规则</h3>
        <div class="row"><div class="label">替换规则<div class="desc" id="rules-count">加载中…</div></div>
          <input type="file" id="rules-file" accept=".json,application/json" hidden />
          <button class="btn" id="rules-import" style="padding:5px 10px;font-size:12px">导入文件</button>
          <button class="btn" id="rules-paste" style="padding:5px 10px;font-size:12px">粘贴</button>
          <button class="btn ghost" id="rules-clear" style="padding:5px 8px;font-size:12px;color:var(--danger)">清空</button></div>
        <div id="rules-list"></div>
      </div>
      <div class="section">
        <h3>版本更新</h3>
        <div class="row"><div class="label">当前版本<div class="desc">V${esc(APP_VER)}</div></div>
          <button class="btn" id="btn-check-update" style="padding:5px 10px;font-size:12px">检查更新</button></div>
        <div id="update-info"></div>
      </div>
      <div class="section">
        <h3>关于</h3>
        <div class="row" id="open-help" style="cursor:pointer"><div class="label">使用帮助<div class="desc">各版块功能与常用操作</div></div><span style="color:var(--text-2)">›</span></div>
        <div class="row" id="open-log" style="cursor:pointer"><div class="label">更新日志<div class="desc" id="log-row-ver">查看历史版本</div></div><span style="color:var(--text-2)">›</span></div>
        <div class="row"><div class="label">阅读 · fnOS 网页版<div class="desc">版本 V1.8.4 · 兼容 Legado 3.x 书源规则</div></div></div>
      </div>`;

    const helpRow = $('#open-help');
    if (helpRow) helpRow.onclick = () => showHelp(true);
    const logVer = $('#log-row-ver');
    if (logVer) {
      const mv = document.querySelector('meta[name="app-version"]');
      logVer.textContent = (mv ? 'v' + mv.getAttribute('content') + ' · ' : '') + '查看历史版本';
    }
    const logRow = $('#open-log');
    if (logRow) logRow.onclick = () => showChangelog();

    $('#set-theme').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      saveConfig({ theme: b.dataset.v });
      $$('#set-theme button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#set-font').onchange = (e) => saveConfig({ fontSize: Number(e.target.value) || 19 });
    $('#set-lh').onchange = (e) => saveConfig({ lineHeight: Number(e.target.value) || 1.85 });

    const [{ sources }, { books }] = await Promise.all([api('/sources'), api('/books')]);
    $('#stat-src').textContent = `${sources.length} 个（${sources.filter((s) => s.enabled).length} 个启用）`;
    $('#stat-book').textContent = `${books.length} 本`;

    // 搜索缓存统计
    try {
      const cs = await api('/searchcache');
      $('#stat-cache').textContent = `${cs.entries} 条 · ${formatSize(cs.bytes)}`;
      $('#clear-cache').onclick = async () => {
        if (!confirm('清空搜索结果缓存？')) return;
        await api('/searchcache', { method: 'DELETE' });
        $('#stat-cache').textContent = '0 条';
        toast('缓存已清空');
      };
    } catch {
      /* 忽略 */
    }

    // 屏蔽 / 替换规则
    const rulesBox = $('#rules-list');
    const rulesCount = $('#rules-count');
    const renderRules = async () => {
      if (!rulesBox) return;
      try {
        const r = await api('/replace-rules');
        if (rulesCount) rulesCount.textContent = `${r.total} 条 · ${r.enabled} 条启用`;
        if (!r.total) {
          rulesBox.innerHTML = '<div class="row"><div class="label">还没有规则<div class="desc">导入 Legado 的 exportReplaceRule.json 即可屏蔽广告</div></div></div>';
          return;
        }
        rulesBox.innerHTML = r.rules
          .map(
            (x, i) =>
              `<div class="row" data-ri="${i}">
                 <div class="label" style="min-width:0">
                   <b style="font-size:13px">${esc(x.name)}</b>
                   <div class="desc" style="word-break:break-all">${esc(x.group || '未分组')} · ${x.isRegex ? '正则' : '文本'}${x.scopeTitle ? ' · 含标题' : ''}</div>
                 </div>
                 <div class="switch ${x.isEnabled !== false ? 'on' : ''}" data-rtoggle="${i}"></div>
                 <button class="btn ghost" data-rdel="${i}" style="padding:6px 8px;color:var(--danger)">删除</button>
               </div>`
          )
          .join('');
      } catch (e) {
        rulesBox.innerHTML = `<div class="row"><div class="label">读取规则失败<div class="desc">${esc(e.message)}</div></div></div>`;
      }
    };

    const fileInput = $('#rules-file');
    const btnImport = $('#rules-import');
    if (btnImport && fileInput) {
      btnImport.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const arr = JSON.parse(text);
          const r = await api('/replace-rules', { method: 'POST', body: { rules: arr, mode: 'merge' } });
          toast(`导入 ${r.imported} 条，共 ${r.total} 条`);
          renderRules();
        } catch (e) {
          toast('导入失败：' + e.message);
        } finally {
          fileInput.value = '';
        }
      };
    }

    const btnPaste = $('#rules-paste');
    if (btnPaste)
      btnPaste.onclick = async () => {
        const text = prompt('粘贴 Legado 替换规则 JSON（数组）：');
        if (!text) return;
        try {
          const arr = JSON.parse(text);
          const r = await api('/replace-rules', { method: 'POST', body: { rules: arr, mode: 'merge' } });
          toast(`导入 ${r.imported} 条，共 ${r.total} 条`);
          renderRules();
        } catch (e) {
          toast('导入失败：' + e.message);
        }
      };

    const btnClearRules = $('#rules-clear');
    if (btnClearRules)
      btnClearRules.onclick = async () => {
        if (!confirm('清空全部替换规则？')) return;
        await api('/replace-rules?all=1', { method: 'DELETE' });
        toast('已清空');
        renderRules();
      };

    if (rulesBox)
      rulesBox.onclick = async (e) => {
        const toggle = e.target.dataset.rtoggle;
        const del = e.target.dataset.rdel;
        if (toggle != null) {
          const on = e.target.classList.contains('on');
          try {
            await api('/replace-rules', { method: 'PATCH', body: { index: Number(toggle), isEnabled: !on } });
            e.target.classList.toggle('on', !on);
            if (rulesCount) {
              const r = await api('/replace-rules');
              rulesCount.textContent = `${r.total} 条 · ${r.enabled} 条启用`;
            }
          } catch (err) {
            toast('操作失败：' + err.message);
          }
        } else if (del != null) {
          if (!confirm('删除这条规则？')) return;
          await api('/replace-rules?index=' + del, { method: 'DELETE' });
          renderRules();
        }
      };
    renderRules();

    // 优先手机解析
    const swPrefer = $('#sw-prefer');
    if (swPrefer)
      swPrefer.onclick = () => {
        const on = !swPrefer.classList.contains('on');
        swPrefer.classList.toggle('on', on);
        saveConfig({ preferRemote: on });
        toast(on ? '搜索将优先交给手机解析' : '已改回本机优先');
      };

    // 软总线摘要
    const busSummary = $('#bus-summary');
    if (busSummary)
      api('/bus')
        .then((r) => {
          const online = (r.devices || []).filter((d) => d.online).length;
          busSummary.textContent = online ? `${online} 台设备在线可代理解析` : '暂无在线设备';
        })
        .catch(() => {});

    // 液态玻璃底栏
    const swGlass = $('#sw-glass');
    if (swGlass)
      swGlass.onclick = () => {
        const on = !swGlass.classList.contains('on');
        swGlass.classList.toggle('on', on);
        saveConfig({ liquidGlass: on });
        toast(on ? '已开启液态玻璃底栏' : '已关闭');
      };

    // 版本更新
    const upBox = $('#update-info');
    const btnCheck = $('#btn-check-update');
    if (btnCheck)
      btnCheck.onclick = async () => {
        btnCheck.disabled = true;
        btnCheck.textContent = '检查中…';
        upBox.innerHTML = '';
        try {
          const r = await api('/update/check?force=1');
          if (!r.hasUpdate) {
            upBox.innerHTML =
              '<div class="row"><div class="label">已是最新版本<div class="desc">远端 ' + esc(r.latest) + '</div></div></div>';
            return;
          }
          upBox.innerHTML =
            '<div class="row"><div class="label">发现新版本 V' + esc(r.latest) +
            '<div class="desc">' + esc(r.name || '') + ' · ' +
            (r.asset ? (r.asset.size / 1024 / 1024).toFixed(2) : '0') + ' MB</div></div></div>' +
            '<div class="row" style="display:block"><div class="desc" style="white-space:pre-wrap;font-size:12px;line-height:1.6">' +
            esc((r.notes || '').slice(0, 600)) + '</div></div>' +
            '<div class="row"><div class="label">下载更新包<div class="desc" id="up-status">点击右侧按钮开始</div></div>' +
            '<button class="btn primary" id="btn-dl-update" style="padding:6px 12px;font-size:12px">下载</button></div>';

          $('#btn-dl-update').onclick = async () => {
            const btn = $('#btn-dl-update');
            btn.disabled = true;
            btn.textContent = '下载中…';
            $('#up-status').textContent = '正在从 GitHub 下载…';
            let d;
            try {
              d = await api('/update/download', { method: 'POST' });
            } catch (e) {
              $('#up-status').textContent = '下载失败：' + e.message;
              btn.disabled = false;
              btn.textContent = '重试';
              return;
            }
            $('#up-status').textContent =
              '已保存：' + d.file + (d.copyPath ? '（也已复制到 ' + d.copyPath + '）' : '');
            btn.remove();

            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML =
              '<div class="label">安装<div class="desc">自动安装需要系统权限，失败会提示手动方式</div></div>' +
              '<button class="btn primary" id="btn-install-update" style="padding:6px 12px;font-size:12px">安装</button>';
            upBox.appendChild(row);

            $('#btn-install-update').onclick = async () => {
              const b = $('#btn-install-update');
              b.disabled = true;
              b.textContent = '安装中…';
              try {
                const r2 = await api('/update/install', { method: 'POST', body: { file: d.file } });
                if (r2.ok) {
                  toast('已提交安装，应用即将重启');
                } else {
                  alert(
                    '无法自动安装：' + (r2.message || '') + '。更新包：' + r2.file +
                      '。请在应用中心 → 手动安装中选择该文件；升级前建议先卸载，数据会保留。'
                  );
                }
              } catch (e) {
                toast('安装失败：' + e.message);
              } finally {
                b.disabled = false;
                b.textContent = '安装';
              }
            };
          };
        } catch (e) {
          upBox.innerHTML =
            '<div class="row"><div class="label">检查失败<div class="desc">' + esc(e.message) + '</div></div></div>';
        } finally {
          btnCheck.disabled = false;
          btnCheck.textContent = '检查更新';
        }
      };

    // 手机接入：接口地址 + token
    // 直连地址：网关（:5666）不能给手机用，服务端会返回 真实端口+局域网IP
    const apiBase = cfg.directBase || location.origin + location.pathname.replace(/\/[^/]*$/, '');
    const baseEl = $('#api-base');
    if (baseEl) baseEl.textContent = apiBase;
    const altEl = $('#api-alts');
    if (altEl && Array.isArray(cfg.lanIps) && cfg.lanIps.length > 1) {
      altEl.textContent = '其它可用地址：' + cfg.lanIps.filter((x) => x !== apiBase).join('  ');
    }
    const tokenEl = $('#api-token');
    const tokenMissing = !cfg.apiToken;
    if (tokenEl)
      tokenEl.textContent = tokenMissing
        ? '（直连访问时不下发令牌，请通过飞牛桌面打开本应用查看）'
        : cfg.apiToken;
    const copy = (text, label) => {
      if (!text) return toast('没有可复制的内容');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(label + '已复制')).catch(() => toast('复制失败'));
      else toast('当前环境不支持复制');
    };
    const cb = $('#copy-base');
    if (cb) cb.onclick = () => copy(apiBase, '接口地址');
    const ct = $('#copy-token');
    if (ct)
      ct.onclick = () =>
        tokenMissing ? toast('请通过飞牛桌面打开本应用查看令牌') : copy(cfg.apiToken || '', '令牌');
    const rt = $('#reset-token');
    if (rt)
      rt.onclick = async () => {
        if (!confirm('重置后旧 App 的 token 会失效，需要重新填写。继续？')) return;
        try {
          const r = await api('/m/reset-token', { method: 'POST' });
          state.config.apiToken = r.apiToken;
          $('#api-token').textContent = r.apiToken;
          toast('令牌已重置');
        } catch (e) {
          toast('重置失败：' + e.message);
        }
      };

    // 阅读 APK 接入：一键生成 legado:// 书源导入链接
    const apkJsonUrl = `${apiBase}api/m/booksource?token=${encodeURIComponent(cfg.apiToken || '')}`;
    const apkImportUrl = 'legado://import/bookSource?src=' + encodeURIComponent(apkJsonUrl);
    const lkEl = $('#apk-src-link');
    if (lkEl) lkEl.textContent = apkImportUrl;
    const jEl = $('#apk-src-json');
    if (jEl) jEl.textContent = apkJsonUrl;
    const clEl = $('#copy-apk-link');
    if (clEl) clEl.onclick = () => copy(apkImportUrl, '书源导入链接');
    const cjEl = $('#copy-apk-json');
    if (cjEl) cjEl.onclick = () => copy(apkJsonUrl, '书源 JSON 地址');

    // 已下载书籍数量 + 保存位置
    try {
      const [{ items }, dirs] = await Promise.all([api('/downloads'), api('/download/dirs')]);
      $('#stat-dl').textContent = `${items.length} 本，点击查看`;
      const sel = $('#set-dir');
      const cur = dirs.current || '';
      sel.innerHTML = dirs.dirs
        .map((d) => `<option value="${esc(d.path)}" ${d.path === cur ? 'selected' : ''}>${esc(d.label)}</option>`)
        .join('');
      const wanted = cfg.downloadDir || '';
      $('#stat-dir').textContent = (cur.replace(/^.*\//, '') || '默认') + (wanted && wanted !== cur ? '（原目录不可写，已回退）' : '');
      sel.onchange = async () => {
        try {
          await api('/config', { method: 'POST', body: { downloadDir: sel.value } });
          toast('下载位置已更新');
          $('#stat-dir').textContent = sel.value.replace(/^.*\//, '');
        } catch (e) {
          toast('设置失败：' + e.message);
        }
      };
    } catch {
      /* 下载信息可选 */
    }
  } catch (e) {
    $('#settings-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------------- 启动 ---------------- */
window.addEventListener('hashchange', router);
window.addEventListener('pagehide', () => {
  if (state.reader) saveProgress();
});
document.addEventListener('keydown', (e) => {
  if (!state.reader || location.hash.indexOf('/read') < 0) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') gotoChapter(state.reader.index - 1);
  if (e.key === 'ArrowRight') gotoChapter(state.reader.index + 1);
});

(async function boot() {
  try {
    const cfg = await api('/config');
    applyConfig(cfg);
  } catch {
    applyConfig({});
  }
  router();
  maybeShowFirstRunHelp();
  if (!parseHash().params.has('noevents')) connectEvents();
})();
