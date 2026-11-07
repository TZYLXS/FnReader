'use strict';
// 极简 SSH/SFTP 客户端（用于把构建推到 fnOS 设备）
//   node ssh.js exec "<cmd>"
//   node ssh.js put <local> <remote>
//   node ssh.js get <remote> <local>
// 连接信息全部来自环境变量：FNOS_HOST / FNOS_USER / FNOS_PASS
const { Client } = require('ssh2');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.FNOS_HOST;
const USER = process.env.FNOS_USER || 'admin';
const PASS = process.env.FNOS_PASS;

if (!HOST || !PASS) {
  console.error('请设置环境变量 FNOS_HOST 与 FNOS_PASS');
  process.exit(2);
}

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 15000 });
  });
}

async function run(cmd) {
  const conn = await connect();
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      let out = '';
      let errOut = '';
      stream
        .on('close', (code) => {
          conn.end();
          resolve({ code, out, err: errOut });
        })
        .on('data', (d) => (out += d.toString()))
        .stderr.on('data', (d) => (errOut += d.toString()));
    });
  });
}

async function put(local, remote) {
  const conn = await connect();
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      const buf = fs.readFileSync(local);
      sftp.writeFile(remote, buf, (e) => {
        conn.end();
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

async function get(remote, local) {
  const conn = await connect();
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      sftp.readFile(remote, (e, buf) => {
        conn.end();
        if (e) reject(e);
        else {
          fs.writeFileSync(local, buf);
          resolve();
        }
      });
    });
  });
}

(async () => {
  const [action, a, b] = process.argv.slice(2);
  try {
    if (action === 'exec') {
      const r = await run(a);
      process.stdout.write(r.out);
      if (r.err) process.stderr.write(r.err);
      process.exitCode = r.code || 0;
    } else if (action === 'put') {
      await put(a, b);
      console.log(`uploaded ${path.basename(a)} -> ${b}`);
    } else if (action === 'get') {
      await get(a, b);
      console.log(`downloaded ${a} -> ${b}`);
    } else {
      console.error('usage: ssh.js exec "<cmd>" | put <local> <remote> | get <remote> <local>');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('SSH error:', e.message);
    process.exitCode = 1;
  }
})();
