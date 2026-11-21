'use strict';

/* ---------------- 基础工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const toastEl = $('#toast');

function coverSrc(url, bookUrl) {
  if (!url) return '';
  // 站内相对路径（/covers/x.png）直接给浏览器，不再走图片代理
  if (url.startsWith('/')) return url + (state.coverVer ? '?v=' + state.coverVer : '');
  return (
    './api/image?url=' + encodeURIComponent(url) +
    (bookUrl ? '&book=' + encodeURIComponent(bookUrl) : '') +
    (state.coverVer ? '&v=' + state.coverVer : '')
  );
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

const THEME_OPTIONS = [
  ['light', '浅色'],
  ['sepia', '羊皮纸'],
  ['dark', '深色'],
  ['book', '旧书'],
  ['eink', '墨水屏（高对比）'],
  ['kindle', 'Kindle 书城'],
  ['amazon', '亚马逊书城'],
];

function themeSelectOptions(current) {
  return THEME_OPTIONS.map(
    ([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`
  ).join('');
}

const state = {
  books: [],
  sources: [],
  config: { theme: 'light', fontSize: 19, lineHeight: 1.85, pageWidth: 720 },
  search: { key: '', selected: new Set(), running: false, es: null, results: [], official: false },
  reader: null,
};

/* ---------------- 配置 ---------------- */
function applyConfig(cfg) {
  state.config = { ...state.config, ...cfg };
  document.documentElement.setAttribute('data-theme', state.config.theme || 'light');
  // 主题切换会影响二级页返回按钮的显隐/配色，立即重算
  try {
    if (typeof injectBack === 'function') injectBack(parseHash().path);
  } catch { /* 首屏可能还没有 DOM */ }
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
  // 亚马逊主题：没有底部标签栏，二级页面在深色顶栏内嵌返回按钮
  const amazon = state.config.theme === 'amazon';
  const reading = path.startsWith('/read');
  $('#tabbar').style.display = reading || amazon ? 'none' : 'grid';
  if (state.search.es && tab !== 'search') {
    state.search.es.close();
    state.search.es = null;
    state.search.running = false;
  }
  window.scrollTo(0, 0);
  let rendered;
  if (path === '/shelf') rendered = renderShelf();
  else if (path === '/search') rendered = renderSearch();
  else if (path === '/sources') rendered = renderSources();
  else if (path === '/settings') rendered = renderSettings();
  else if (path === '/daily') rendered = renderDaily();
  else if (path === '/bus') rendered = renderBus();
  else if (path === '/detail') rendered = renderDetail();
  else if (path === '/feeds') rendered = renderFeeds();
  else if (path === '/downloads' || path === '/offline') rendered = renderOffline();
  else if (path === '/setup') rendered = renderSetup();
  else if (path.startsWith('/read')) rendered = openReader(params.get('url'), params.get('title'));
  else rendered = renderShelf();
  // 顶栏可能异步渲染，立即插一次 + 下一帧补一次
  injectBack(path);
  setTimeout(() => injectBack(path), 60);
  return rendered;
}

/** 亚马逊主题：把返回按钮嵌进深色顶栏，跟标题同一行对齐 */
function injectBack(path) {
  document.querySelectorAll('.topbar .backbtn').forEach((n) => n.remove());
  if (state.config.theme !== 'amazon' || path === '/shelf' || path.startsWith('/read')) return;
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const a = document.createElement('a');
  a.className = 'backbtn';
  a.href = '#/shelf';
  a.setAttribute('aria-label', '返回书架');
  a.textContent = '‹';
  bar.prepend(a);
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
    // 亚马逊书城风格：深色导航 + 搜索 + 分类条 + 筛选栏 + 结果列表
    if (state.config.theme === 'amazon') {
      const localOf = (b) => String(b.bookUrl || '').startsWith('ebook://');
      const reading = books.filter((b) => b.durChapterIndex > 0);
      const pctOf = (b) => Math.min(100, Math.round(((b.durChapterIndex + 1) / (b.totalChapterNum || 1)) * 100));
      const cover = (b) => `<div class="amz-cover">${
        b.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(b.coverUrl, b.bookUrl))}" onerror="this.remove()" />` : ''
      }</div>`;
      const item = (b) => {
        const pct = b.durChapterIndex ? pctOf(b) : 0;
        const hasRating = typeof b.rating === 'number' && b.rating > 0;
        const starPct = hasRating ? Math.round((b.rating / 5) * 100) : pct;
        const rateText = hasRating
          ? `${b.rating.toFixed(1)}${b.ratingCount ? ` · ${b.ratingCount} 评分` : ' 评分'}`
          : (b.durChapterIndex ? `已读 ${b.durChapterIndex + 1}/${b.totalChapterNum || '?'} 章` : '尚未开始');
        return `
        <article class="amz-item" data-url="${esc(b.bookUrl)}">
          <div class="amz-item-cover">${cover(b)}</div>
          <div class="amz-item-body">
            <h3 class="amz-item-title">${esc(b.name)}</h3>
            <div class="amz-item-meta">${esc(b.author || '未知作者')} | ${localOf(b) ? '本地电子书' : '网文'} | ${
              b.totalChapterNum ? esc(b.totalChapterNum) + ' 章' : '待解析'
            }</div>
            <div class="amz-item-rate">
              <span class="amz-stars" style="--pct:${starPct}%">★★★★★</span>
              <span class="amz-rate-num">${rateText}</span>
            </div>
            <div class="amz-item-bar"><i style="width:${pct}%"></i></div>
            <div class="amz-item-actions">
              <button class="amz-buy" data-url="${esc(b.bookUrl)}">${b.durChapterIndex ? '继续阅读' : '开始阅读'}</button>
              <a class="amz-item-link" href="#/detail?url=${encodeURIComponent(b.bookUrl)}">详情</a>
              <button class="amz-item-link" data-more="1">更多</button>
            </div>
          </div>
        </article>`;
      };

      view.innerHTML = `
        <header class="amz-head">
          <div class="amz-top">
            <a class="amz-brand" href="#/shelf">飞牛阅读</a>
            <form class="amz-search" id="amz-search">
              <select id="amz-scope" aria-label="搜索范围"><option value="book">图书</option><option value="author">作者</option></select>
              <input id="amz-kw" type="search" placeholder="搜索书名、作者或书源" enterkeyhint="search" />
              <button type="submit" aria-label="搜索">
                <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.6" fill="none" stroke="#111" stroke-width="2.1"/>
                  <path d="M12.8 12.8 L17.2 17.2" stroke="#111" stroke-width="2.1" stroke-linecap="round"/>
                </svg>
              </button>
            </form>
            <div class="amz-toplinks"><a href="#/settings">设置</a><a href="#/sources">书源</a></div>
          </div>
          <nav class="amz-catnav" id="amz-nav">
            <button class="amz-chip on" data-f="all">全部</button>
            <button class="amz-chip" data-f="reading">在读 ${reading.length}</button>
            <button class="amz-chip" data-f="unread">未读 ${books.length - reading.length}</button>
            <button class="amz-chip" data-f="local">本地电子书</button>
            <a class="amz-chip amz-chip-link" href="#/settings">设置</a>
            <span class="amz-cat-ind" id="amz-ind" aria-hidden="true"></span>
          </nav>
        </header>
        <main class="amz-main">
          <div class="amz-crumb">书籍 › 我的书架</div>
          <div class="amz-layout">
            <aside class="amz-side">
              <div class="amz-side-group"><h4>格式</h4>
                <button class="amz-side-link on" data-filter="all">全部</button>
                <button class="amz-side-link" data-filter="local">本地电子书</button>
                <button class="amz-side-link" data-filter="web">网文</button>
              </div>
              <div class="amz-side-group"><h4>阅读状态</h4>
                <button class="amz-side-link" data-filter="reading">在读</button>
                <button class="amz-side-link" data-filter="unread">未读</button>
              </div>
              <div class="amz-side-group"><h4>操作</h4>
                <button class="amz-side-link" id="amz-refresh">刷新目录</button>
                <a class="amz-side-link" href="#/sources">书源管理</a>
                <a class="amz-side-link" href="#/settings">设置</a>
              </div>
            </aside>
            <section class="amz-content">
              <div class="amz-results-head">
                <h1>结果</h1>
                <span class="amz-count" id="amz-count"></span>
                <label class="amz-sort">排序方式：
                  <select id="amz-sort">
                    <option value="recent">最近阅读</option>
                    <option value="name">书名</option>
                    <option value="progress">阅读进度</option>
                  </select>
                </label>
              </div>
              <div class="amz-list" id="amz-list"></div>
            </section>
          </div>
        </main>`;

      let filter = 'all';
      let sort = 'recent';
      const renderList = () => {
        let list = books.slice();
        if (filter === 'reading') list = list.filter((b) => b.durChapterIndex > 0);
        else if (filter === 'unread') list = list.filter((b) => !b.durChapterIndex);
        else if (filter === 'local') list = list.filter(localOf);
        else if (filter === 'web') list = list.filter((b) => !localOf(b));
        if (sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans'));
        else if (sort === 'progress') list.sort((a, b) => pctOf(b) - pctOf(a));
        else list.sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
        $('#amz-count').textContent = list.length
          ? `显示：1-${list.length} 条，共 ${books.length} 条`
          : `没有符合条件的结果，共 ${books.length} 条`;
        $('#amz-list').innerHTML = list.length ? list.map(item).join('') : '<div class="amz-empty">没有符合条件的书</div>';
      };
      const syncChips = () => {
        view.querySelectorAll('.amz-chip').forEach((c) => c.classList.toggle('on', c.dataset.f === filter));
        moveInd();
      };
      const moveInd = () => {
        const ind = document.getElementById('amz-ind');
        const on = view.querySelector('.amz-chip.on');
        if (!ind || !on) return;
        ind.style.left = on.offsetLeft + 'px';
        ind.style.width = on.offsetWidth + 'px';
      };
      if (window.__amzMoveInd) window.removeEventListener('resize', window.__amzMoveInd);
      window.__amzMoveInd = moveInd;
      window.addEventListener('resize', moveInd);
      const syncSide = () => view.querySelectorAll('.amz-side-link[data-filter]').forEach((c) => c.classList.toggle('on', c.dataset.filter === filter));

      $('#amz-search').onsubmit = (e) => {
        e.preventDefault();
        const kw = $('#amz-kw').value.trim();
        if (!kw) return;
        state.search.key = kw;
        location.hash = '#/search';
      };
      $('#amz-nav').onclick = (e) => {
        const b = e.target.closest('.amz-chip');
        if (!b) return;
        filter = b.dataset.f;
        syncChips();
        syncSide();
        renderList();
        requestAnimationFrame(moveInd);
      };
      view.querySelectorAll('.amz-side-link[data-filter]').forEach((b) => {
        b.onclick = () => {
          filter = b.dataset.filter;
          syncChips();
          syncSide();
          renderList();
        };
      });
      const sortSel = $('#amz-sort');
      if (sortSel) sortSel.onchange = () => { sort = sortSel.value; renderList(); };
      const rf = $('#amz-refresh');
      if (rf) rf.onclick = refreshAllTocs;

      bindShelfEvents(view);
      renderList();
      requestAnimationFrame(moveInd);
      return;
    }
    // Kindle 书城风格：继续阅读 + 最近在读横排 + 全部书籍网格
    if (state.config.theme === 'kindle') {
      const reading = books
        .filter((b) => b.durChapterIndex > 0)
        .sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
      const recent = reading.slice(0, 10);
      const hero = reading[0];
      const card = (b, cls) => `
        <div class="store-card ${cls || ''}" data-url="${esc(b.bookUrl)}">
          <div class="store-cover">${
            b.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(b.coverUrl, b.bookUrl))}" onerror="this.remove()" />` : ''
          }</div>
          <div class="store-name">${esc(b.name)}</div>
          <div class="store-meta">${esc(b.author || '')}${typeof b.rating === 'number' && b.rating > 0 ? ` · ★ ${b.rating.toFixed(1)}` : ''}</div>
          <button class="more" data-more="1" aria-label="更多">⋯</button>
        </div>`;
      body.innerHTML = `
        <section class="store-hero">
          ${
            hero
              ? `<div class="hero-card" data-url="${esc(hero.bookUrl)}">
                  <div class="hero-cover">${
                    hero.coverUrl ? `<img loading="lazy" src="${esc(coverSrc(hero.coverUrl, hero.bookUrl))}" onerror="this.remove()" />` : ''
                  }</div>
                  <div class="hero-info">
                    <div class="hero-kicker">继续阅读</div>
                    <div class="hero-title">${esc(hero.name)}</div>
                    <div class="hero-meta">${esc(hero.author || '')}${typeof hero.rating === 'number' && hero.rating > 0 ? ` · ★ ${hero.rating.toFixed(1)}` : ''} · 读到第 ${hero.durChapterIndex + 1}/${hero.totalChapterNum || '?'} 章</div>
                    <div class="hero-bar"><i style="width:${Math.min(100, Math.round(((hero.durChapterIndex + 1) / (hero.totalChapterNum || 1)) * 100))}%"></i></div>
                    <button class="hero-btn" data-url="${esc(hero.bookUrl)}">继续阅读</button>
                  </div>
                </div>`
              : `<div class="hero-empty">从下方书架挑一本书开始阅读</div>`
          }
        </section>
        ${
          recent.length
            ? `<section class="store-row"><div class="row-head"><h2>最近在读</h2><span>${recent.length} 本</span></div>
                <div class="row-scroll">${recent.map((b) => card(b, 'small')).join('')}</div></section>`
            : ''
        }
        <section class="store-row"><div class="row-head"><h2>我的书架</h2><span>${books.length} 本</span></div>
          <div class="store-grid">${books.map((b) => card(b)).join('')}</div></section>`;
      bindShelfEvents(body);
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
const SHELF_CARD_SEL = '.book-card, .amz-item, .store-card';

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
    const card = e.target.closest(SHELF_CARD_SEL);
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
    // 详情等普通链接交给浏览器
    if (e.target.closest('a:not([data-more])')) return;
    const more = e.target.closest('[data-more]');
    if (more) {
      e.preventDefault();
      e.stopPropagation();
      const card = more.closest(SHELF_CARD_SEL);
      if (card) bookMenu(card.dataset.url);
      return;
    }
    const card = e.target.closest(SHELF_CARD_SEL);
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
      <button class="chip ${state.search.official ? 'on' : ''}" id="chip-official" title="包含起点 / QQ阅读 / 掌阅等正版接口源">正版源</button>
      <button class="chip" id="chip-daily">每日推荐</button>
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
    if (b.id === 'chip-daily') {
      location.hash = '#/daily';
      return;
    }
    if (b.id === 'chip-remote') {
      state.search.remote = !state.search.remote;
      b.classList.toggle('on', state.search.remote);
      toast(state.search.remote ? '已开启手机解析：本机解析失败的源会交给手机' : '已关闭手机解析');
      return;
    }
    if (b.id === 'chip-official') {
      state.search.official = !state.search.official;
      b.classList.toggle('on', state.search.official);
      toast(state.search.official ? '已包含正版接口源（起点/QQ阅读/掌阅等）' : '已排除正版接口源');
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

async function renderDaily() {
  view.innerHTML = `
    <header class="topbar"><button class="icon-btn" id="daily-back">‹</button><h1>每日推荐</h1>
      <button class="btn" id="daily-refresh" style="padding:5px 10px;font-size:12px">换一批</button>
    </header>
    <div id="daily-box"><div class="empty"><span class="spinner"></span> 正在取榜单…</div></div>`;

  $('#daily-back').onclick = () => (location.hash = '#/search');
  $('#daily-refresh').onclick = () => load(true);

  async function load(force) {
    const box = $('#daily-box');
    box.innerHTML = '<div class="empty"><span class="spinner"></span> 正在取榜单…</div>';
    try {
      const r = await api('/daily' + (force ? '?t=' + Date.now() : ''));
      const books = r.books || [];
      if (!books.length) {
        box.innerHTML = `<div class="empty">${esc(r.error || '榜单为空')}</div>`;
        return;
      }
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      box.innerHTML = `
        <div class="daily-head">
          <h2>今日推荐</h2>
          <div class="src">来源：${esc(r.source)} · ${books.length} 本 · ${esc(when)}${r.cached ? ' · 缓存' : ''}</div>
        </div>
        <div class="daily-list">
          ${books
            .map(
              (b) => `<div class="daily-item" data-name="${esc(b.name)}">
                <div class="rk">${b.rank}</div>
                <div class="nm"><b>${esc(b.name)}</b>${b.author ? `<span class="au">${esc(b.author)}</span>` : ''}</div>
                ${b.score ? `<div class="sc">${esc(b.score)}</div>` : ''}
              </div>`
            )
            .join('')}
        </div>`;
      box.onclick = (e) => {
        const item = e.target.closest('.daily-item');
        if (!item) return;
        location.hash = '#/search?key=' + encodeURIComponent(item.dataset.name);
      };
    } catch (e) {
      box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  await load(false);
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

  const fetchIntro = async (auto) => {
    const btn = $('#fetch-intro');
    const box = $('#detail-intro');
    if (!box) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '获取中…';
    }
    if (auto) box.textContent = '正在获取简介…';
    try {
      const q =
        '/intro?name=' +
        encodeURIComponent(b.name) +
        '&author=' +
        encodeURIComponent(b.author || '') +
        '&url=' +
        encodeURIComponent(b.bookUrl || url) +
        '&origin=' +
        encodeURIComponent(b.origin || '');
      const r = await api(q);
      if (!r.intro) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '没找到，重试';
        }
        if (auto) box.textContent = '暂无简介';
        return;
      }
      b.intro = r.intro;
      box.textContent = r.intro;
      if (btn) btn.remove();
      const tip = document.createElement('div');
      tip.className = 'desc';
      tip.style.cssText = 'font-size:11.5px;color:var(--text-2);margin-top:8px';
      tip.textContent = '简介来源：' + (r.source || '未知') + (r.via === 'phone' ? '（手机解析）' : '');
      box.after(tip);
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '获取失败，重试';
      }
      if (auto) box.textContent = '暂无简介';
      if (!auto) toast('获取简介失败：' + e.message);
    }
  };

  const fetchBtn = $('#fetch-intro');
  if (fetchBtn) fetchBtn.onclick = () => fetchIntro(false);
  if (!b.intro) fetchIntro(true);
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
    btn.textContent = '获取目录…';
    toast('已加入书架，正在获取完整目录…');
    // 强制 refresh=1：确保拿到全部章节（含分页），而不是书架里的旧/空目录
    try {
      const d = await api('/toc?refresh=1&url=' + encodeURIComponent(book.bookUrl));
      const n = (d.chapters || []).length;
      if (n) {
        book.chapters = d.chapters;
        book.totalChapterNum = n;
        if (state.books) {
          const hit = state.books.find((x) => x.bookUrl === book.bookUrl);
          if (hit) {
            hit.chapters = d.chapters;
            hit.totalChapterNum = n;
            hit.chapterCount = n;
          }
        }
        btn.textContent = '开始阅读';
        const srcText = d.via === 'phone' || d.via === 'phone-cache' ? '（手机解析）' : '';
        toast(`《${book.name}》共 ${n} 章${srcText}`);
      } else {
        btn.textContent = '已在书架';
        toast('已加入书架（目录为空）');
      }
    } catch (e) {
      btn.textContent = '已在书架';
      toast('已加入书架，目录稍后会自动补全');
    }
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
  if (state.search.official) params.set('official', '1');
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
    if (msg.type === 'note') {
      const h = $('#academic-hint');
      if (h) {
        h.style.display = 'block';
        h.textContent = msg.message || '';
      }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确保 PDF 原页已渲染，返回总页数（0 表示失败） */
async function ensurePages(sha1, onProgress) {
  let st = await api('/ebook/pages?sha1=' + encodeURIComponent(sha1)).catch(() => null);
  if (st && st.ready) return st.count || 0;
  await api('/ebook/pages', { method: 'POST', body: { sha1 } }).catch(() => {});
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    st = await api('/ebook/pages?sha1=' + encodeURIComponent(sha1)).catch(() => null);
    if (onProgress) onProgress(st);
    if (st && st.ready) return st.count || 0;
    if (i > 10 && st && !st.rendering && !st.ready) break;
  }
  return 0;
}

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
    let { chapters } = await api('/toc?url=' + encodeURIComponent(bookUrl));
    if (!chapters || !chapters.length) throw new Error('目录为空');
    book.chapters = chapters;
    book.totalChapterNum = chapters.length;

    // 原页模式：章节列表换成「第 N 页」，翻页/目录都按页走
    const keepPage = state.reader && state.reader.pageMode;
    const isPdf = (book.localEbook && book.localEbook.format === 'pdf') || book.ebookFormat === 'pdf';
    if (keepPage && isPdf) {
      const sha = (book.localEbook && book.localEbook.sha1) || (String(bookUrl).startsWith('ebook://') ? String(bookUrl).slice(8).split(/[?#]/)[0] : '');
      if (sha) {
        view.innerHTML = `<div class="reader"><div class="empty"><span class="spinner"></span> 正在准备原页…<div class="desc" id="page-progress" style="margin-top:8px"></div></div></div>`;
        const count = await ensurePages(sha, (st) => {
          const tip = document.getElementById('page-progress');
          if (tip) tip.textContent = st && st.ready ? `已渲染 ${st.count} 页` : '渲染中…（首次约 1–2 分钟）';
        });
        if (count > 0) {
          const prev = state.reader;
          const ratio = prev && prev.chapters.length ? (prev.index + 1) / prev.chapters.length : 0;
          const targetPage = Math.max(0, Math.min(count - 1, Math.round(ratio * count) - 1));
          chapters = Array.from({ length: count }, (_, i) => ({ index: i, title: `第 ${i + 1} 页`, url: bookUrl + '#' + (i + 1) }));
          book.totalChapterNum = count;
        } else {
          toast('原页渲染失败，已回到文字模式');
          state.reader = null;
        }
      }
    }
    let idx = Math.min(book.durChapterIndex || 0, chapters.length - 1);
    if (state.reader && state.reader.pageMode && state.reader.index >= 0) idx = Math.min(state.reader.index, chapters.length - 1);
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
    const keepPageMode = state.reader && state.reader.pageMode && book.bookUrl === state.reader.book.bookUrl;
    state.reader = { book, chapters, index: idx, pageMode: !!keepPageMode };
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
        ${
          book.localEbook
            ? `<button class="icon-btn" id="toggle-local" title="切换本地副本 / 网文源">${book.contentSource === 'source' ? '本' : '网'}</button>`
            : ''
        }
        ${
          (book.localEbook && book.localEbook.format === 'pdf') || book.ebookFormat === 'pdf'
            ? `<button class="icon-btn" id="toggle-page-mode" title="文字 / 原图">${state.reader.pageMode ? '文' : '图'}</button>`
            : ''
        }
        <button class="icon-btn" id="switch-src" title="换源">⇄</button>
        <button class="icon-btn" id="catalog">☰</button>
        <button class="icon-btn" id="reader-settings">Aa</button>
      </header>
      <main class="article-wrap" id="article-wrap" aria-label="正文，左右滑动或点击两侧翻页">
        <article class="article" id="article"></article>
        <div class="gesture-tip" aria-hidden="true"><span>左右滑动翻页</span><span>点击两侧亦可</span></div>
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
  const pageBtn = $('#toggle-page-mode');
  if (pageBtn) {
    pageBtn.onclick = async () => {
      const r = state.reader;
      if (!r) return;
      const toPage = !r.pageMode;
      const title = r.chapters[r.index] ? r.chapters[r.index].title : '';
      const ratio = r.chapters.length ? (r.index + 1) / r.chapters.length : 0;
      if (toPage) {
        const sha = (r.book.localEbook && r.book.localEbook.sha1) || (String(r.book.bookUrl).startsWith('ebook://') ? String(r.book.bookUrl).slice(8).split(/[?#]/)[0] : '');
        if (!sha) return toast('这本书没有本地原文件');
        view.innerHTML = `<div class="reader"><div class="empty"><span class="spinner"></span> 正在准备原页…<div class="desc" id="page-progress" style="margin-top:8px"></div></div></div>`;
        const count = await ensurePages(sha, (st) => {
          const tip = document.getElementById('page-progress');
          if (tip) tip.textContent = st && st.ready ? `已渲染 ${st.count} 页` : '渲染中…（首次约 1–2 分钟）';
        });
        if (!count) {
          toast('原页渲染失败，保持文字模式');
          return openReader(r.book.bookUrl, title);
        }
        r.pageMode = true;
        r.pageTotal = count;
        state.reader = { ...r, pageMode: true, pageTotal: count, index: Math.max(0, Math.round(ratio * count) - 1) };
        await openReader(r.book.bookUrl, '');
        return;
      }
      r.pageMode = false;
      r.pageTotal = 0;
      await openReader(r.book.bookUrl, title);
    };
  }
  const toggleLocal = $('#toggle-local');
  if (toggleLocal) {
    toggleLocal.onclick = async () => {
      const r = state.reader;
      if (!r || !r.book.localEbook) return;
      const next = r.book.contentSource === 'source' ? 'local' : 'source';
      const title = r.chapters[r.index] ? r.chapters[r.index].title : '';
      try {
        await api('/books/content-source', { method: 'POST', body: { url: r.book.bookUrl, source: next } });
        r.book.contentSource = next;
        toast(next === 'local' ? '已切到本地副本' : '已切回网文源');
        await openReader(r.book.bookUrl, title);
      } catch (e) {
        toast('切换失败：' + e.message);
      }
    };
  }
  $('#switch-src').onclick = openSwitchSource;
  $('#catalog').onclick = toggleDrawer;
  $('#drawer-mask').onclick = toggleDrawer;
  $('#prev').onclick = () => gotoChapter(state.reader.index - 1);
  $('#next').onclick = () => gotoChapter(state.reader.index + 1);
  $('#reader-settings').onclick = openReaderSettings;
  if (window.ReaderGestures && $('#article-wrap')) {
    window.ReaderGestures.bind($('#article-wrap'), {
      navigate: (delta) => {
        const rr = state.reader;
        if (!rr) return;
        rr.turnDirection = delta;
        gotoChapter(rr.index + delta);
      },
      hasSelection: () => {
        const selection = window.getSelection && window.getSelection();
        return !!(selection && !selection.isCollapsed && String(selection).trim());
      },
      isBlocked: () => {
        const drawer = $('#drawer');
        const modal = $('#modal');
        return !!((drawer && !drawer.classList.contains('hidden')) || (modal && !modal.classList.contains('hidden')));
      },
    });
  }

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
    const r = state.reader;
    const list = $('#chapter-list');
    if (!r || !list) return;
    // 打开目录时先把当前章标出来，再按索引算滚动位置（不用 scrollIntoView，
    // 它会把整页一起滚走，表现成「目录总是停在最后一张」）
    const items = $$('#chapter-list .item');
    items.forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === r.index));
    const cur = items[r.index];
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.clientHeight / 2);
    else list.scrollTop = 0;
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
  const maxIdx = r.pageMode && r.pageTotal ? r.pageTotal - 1 : r.chapters.length - 1;
  $('#prev').disabled = index === 0;
  $('#next').disabled = index >= maxIdx;
  updateReaderMeta();

  let data;
  if (r.pageMode) {
    const pageUrl = () => `./api/content?url=${encodeURIComponent(r.book.bookUrl)}&index=${index}&mode=page`;
    const fetchPage = async () => {
      const resp = await fetch(pageUrl());
      let body = {};
      try {
        body = await resp.json();
      } catch {
        body = {};
      }
      return { status: resp.status, body };
    };
    let got = await fetchPage();
    if (got.status === 409 && got.body.needPages) {
      const sha = got.body.sha1;
      article.innerHTML = `<div class="loading"><span class="spinner"></span> 正在渲染原页（PDF 图表）…<div class="desc" id="page-progress" style="margin-top:8px"></div></div>`;
      // 服务端已经在渲染；这里只等待，必要时再补一次触发
      for (let i = 0; i < 300; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const st = await api('/ebook/pages?sha1=' + encodeURIComponent(sha)).catch(() => null);
        const tip = $('#page-progress');
        if (st && tip) tip.textContent = st.ready ? `已渲染 ${st.count} 页` : '渲染中…（首次约 1–2 分钟）';
        if (st && st.ready) break;
        if (i === 3 && st && !st.rendering && !st.ready) {
          await api('/ebook/pages', { method: 'POST', body: { sha1: sha } }).catch(() => {});
        }
        if (i > 12 && st && !st.rendering && !st.ready) {
          article.innerHTML = `<div class="loading">原页渲染失败（可在设置里查看日志）</div>`;
          return;
        }
      }
      got = await fetchPage();
    }
    data = got.status === 200 ? got.body : { error: got.body.error || `请求失败 (${got.status})` };
    if (data && data.page && data.total) {
      r.pageTotal = data.total;
      r.index = data.page - 1;
    }
  } else {
    data = await api(`/content?url=${encodeURIComponent(r.book.bookUrl)}&index=${index}`).catch((e) => ({ error: e.message }));
  }
  if (r.index !== index) return;
  if (data.error) {
    article.innerHTML = `<div class="loading">加载失败：${esc(data.error)}</div>`;
    return;
  }
  article.innerHTML = '';
  const h = document.createElement('h2');
  h.className = 'chapter-head';
  h.textContent =
    r.pageMode && (data.page || r.pageTotal)
      ? `第 ${data.page || index + 1} 页${r.pageTotal ? ' / 共 ' + r.pageTotal + ' 页' : ''}`
      : (r.chapters[index] && r.chapters[index].title) || (data.title || '');
  article.appendChild(h);
  for (const p of data.paragraphs) {
    if (p && typeof p === 'object' && p.k === 'img' && p.t) {
      const img = document.createElement('img');
      img.className = 'page-img';
      img.loading = 'lazy';
      // 服务端返回的是 /api/... 绝对路径；本应用可能在网关子路径下（/app/legado-web/），要改相对
      const raw = String(p.t);
      img.src = raw.startsWith('/api/') ? '.' + raw : raw;
      article.appendChild(img);
      continue;
    }
    const el = document.createElement('p');
    el.textContent = typeof p === 'string' ? p : (p && p.t) || '';
    article.appendChild(el);
  }
  updateReaderMeta();
  // 内容整体替换后浏览器会把位置「锚」在底部，翻章后要重置到顶部
  article.style.overflowAnchor = 'none';
  if (r && r.turnDirection && article.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    article.animate(
      [{ opacity: 0.72, transform: `translateX(${r.turnDirection * 14}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 180, easing: 'ease-out' }
    );
    r.turnDirection = 0;
  }
  const toTop = () => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const wrap = article.closest('.article-wrap');
    if (wrap) wrap.scrollTop = 0;
  };
  toTop();
  requestAnimationFrame(toTop);
  setTimeout(toTop, 60);
  saveProgress();
}

/** 顶部书名、底部进度、进度条 */
function updateReaderMeta() {
  const r = state.reader;
  if (!r) return;
  const total = (r.pageMode && r.pageTotal) || r.chapters.length || 1;
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
  const max = r && r.pageMode && r.pageTotal ? r.pageTotal : r && r.chapters.length;
  if (!r || index < 0 || index >= max) return;
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
      <select class="scope-select theme-select" id="sel-theme">${themeSelectOptions(cfg.theme)}</select>
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
  const selTheme = $('#sel-theme');
  if (selTheme)
    selTheme.onchange = () => {
      saveConfig({ theme: selTheme.value });
      toast('主题已切换');
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

/* ---------------- 安装/更新后的缓存位置确认 ---------------- */
async function renderSetup() {
  $('#tabbar').style.display = 'none';
  view.innerHTML = `
    <div class="setup-page">
      <header class="topbar"><h1>先确认缓存保存位置</h1></header>
      <div class="section">
        <h3>安装/更新完成</h3>
        <div class="row"><div class="label">当前版本<div class="desc" id="setup-ver">-</div></div></div>
        <div class="row" style="display:block">
          <div class="label">缓存保存位置<div class="desc">App 缓存的章节与图片会存到这个目录下的 cache/</div></div>
          <input id="setup-dir" style="width:100%;margin-top:8px;font-size:13px" />
          <div class="desc" id="setup-hint" style="margin-top:6px">确认后自动创建目录并开启软总线（手机端任务接收）。</div>
        </div>
        <div class="row" style="display:block">
          <div class="label">可选目录</div>
          <select id="setup-pick" style="width:100%;margin-top:8px;font-size:12px"></select>
        </div>
      </div>
      <div class="section">
        <div class="row">
          <button class="btn primary" id="setup-ok" style="padding:10px 18px">确认并开启软总线</button>
        </div>
      </div>
    </div>`;
  let st = {};
  try {
    st = await api('/setup');
  } catch {
    st = {};
  }
  const ver = $('#setup-ver');
  if (ver) ver.textContent = 'V' + (st.version || APP_VER);
  const input = $('#setup-dir');
  if (input) input.value = st.cacheDir || '';
  const pick = $('#setup-pick');
  if (pick && st.dirs) {
    pick.innerHTML = st.dirs
      .map((d) => `<option value="${esc(d.path)}" ${d.path === st.cacheDir ? 'selected' : ''}>${esc(d.label)} — ${esc(d.path)}</option>`)
      .join('');
    pick.onchange = () => {
      if (input) input.value = pick.value;
    };
  }
  const ok = $('#setup-ok');
  if (ok) {
    ok.onclick = async () => {
      const dir = (input && input.value.trim()) || '';
      if (!dir) return toast('请填写目录');
      ok.disabled = true;
      ok.textContent = '确认中…';
      try {
        const r = await api('/setup/confirm', { method: 'POST', body: { cacheDir: dir } });
        toast('缓存位置已确认，软总线已开启');
        if (r && r.cacheDir) {
          const hint = $('#setup-hint');
          if (hint) hint.textContent = '缓存目录：' + r.cachePath;
        }
        setTimeout(() => (location.hash = '#/shelf'), 400);
      } catch (e) {
        toast('确认失败：' + e.message);
        ok.disabled = false;
        ok.textContent = '确认并开启软总线';
      }
    };
  }
}

/* ---------------- 已下载 ---------------- */
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function checkUpdateNotice() {
  try {
    const r = await api('/update/check');
    if (!r || !r.hasUpdate) return;
    const ignored = localStorage.getItem('legado.ignoreUpdate') || '';
    if (ignored === r.latest) return;
    const modal = $('#modal');
    const box = $('#modal-box');
    box.innerHTML = `
      <h3>发现新版本 V${esc(r.latest)}</h3>
      <div class="desc" style="font-size:12px;color:var(--text-2);margin-top:4px">当前 V${esc(r.current)}</div>
      <pre class="md-code" style="white-space:pre-wrap;max-height:34vh;overflow:auto;font-size:12px;margin-top:10px">${esc((r.notes || '').slice(0, 600))}</pre>
      <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="btn ghost" id="up-ignore">忽略此版本</button>
        <button class="btn" id="up-later">稍后</button>
        ${
          r.url
            ? `<a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener">查看更新</a>`
            : '<span class="desc">暂无下载地址</span>'
        }
      </div>`;
    modal.classList.remove('hidden');
    const close = () => modal.classList.add('hidden');
    box.querySelector('#up-later').onclick = close;
    box.querySelector('#up-ignore').onclick = () => {
      try {
        localStorage.setItem('legado.ignoreUpdate', r.latest);
      } catch {
        /* ignore */
      }
      close();
    };
  } catch {
    /* 更新检查失败静默 */
  }
}

async function renderOffline() {
  view.innerHTML = `
    <header class="topbar"><h1>离线缓存</h1><span class="desc" style="color:var(--text-2);font-size:12px">全部</span></header>
    <div id="off-body"><div class="empty">加载中…</div></div>`;
  const body = $('#off-body');
  try {
    const data = await api('/offline');
    const items = data.items || [];
    if (!items.length) {
      body.innerHTML = `<div class="empty"><div class="big">📥</div>还没有离线内容<br />在书架长按书封「下载整本 TXT」，或扫描本地电子书</div>`;
      return;
    }
    body.innerHTML =
      `<div class="section" style="margin-top:12px">` +
      items
        .map((it) => {
          const pct = it.total ? Math.round((it.downloaded / it.total) * 100) : 0;
          const sub = [
            it.author || '',
            it.format ? it.format.toUpperCase() : '',
            `已下载 ${it.downloaded}/${it.total || it.downloaded}`,
            it.size ? formatSize(it.size) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const href =
            it.kind === 'ebook'
              ? `./api/ebook/export?sha1=${encodeURIComponent(it.sha1)}`
              : it.hasTxt
                ? `./api/download/file?url=${encodeURIComponent(it.bookUrl)}`
                : '';
          return `<div class="source-item">
            <div class="name">
              <b>${esc(it.name)}</b>
              <span>${esc(sub)}</span>
              <span style="color:var(--text-2);font-size:11px">${pct}% · ${it.kind === 'ebook' ? '本地电子书' : '在线书籍'}</span>
            </div>
            ${
              href
                ? `<a class="btn" download style="padding:6px 10px;font-size:12px" href="${href}">导出</a>`
                : `<span style="color:var(--text-2);font-size:12px">仅章节缓存</span>`
            }
          </div>`;
        })
        .join('') +
      `</div>
      <div class="row" id="off-export-progress" style="display:none;margin:12px 16px 0;align-items:flex-start">
        <div class="label" style="flex:1">
          <div id="off-exp-title">准备导出…</div>
          <div class="desc" id="off-exp-desc">0 / 0</div>
          <div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:8px">
            <i id="off-exp-bar" style="display:block;height:100%;width:0;background:var(--accent);transition:width .25s"></i>
          </div>
        </div>
      </div>
      <div class="row" style="margin:12px 16px"><div class="label">合计<div class="desc">在线 ${data.books} 本 · 电子书 ${data.ebooks} 本</div></div>
      <button class="btn" id="off-export-all" style="padding:5px 10px;font-size:12px">导出全部 TXT</button></div>`;
    const all = $('#off-export-all');
    if (all) all.onclick = () => exportAllTxt(all).catch(() => {});
  } catch (e) {
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}



/** 导出全部 TXT：服务端异步任务（Python 导出）+ 进度条轮询，避免网关超时返回 HTML 错误页 */
async function exportAllTxt(btn) {
  const label = (t) => { if (btn) btn.textContent = t; };
  const box = $('#off-export-progress');
  const bar = $('#off-exp-bar');
  const title = $('#off-exp-title');
  const desc = $('#off-exp-desc');
  const show = () => { if (box) box.style.display = 'flex'; };
  const paint = (st) => {
    const total = st.total || 0;
    const done = st.done || 0;
    const doneCh = st.chapters || 0;
    const totalCh = st.totalChapters || 0;
    // 进度以「章」为主；章节总数还没统计出来时先按本算
    const pct = totalCh ? Math.min(100, Math.round((doneCh / totalCh) * 100)) : total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (bar) bar.style.width = pct + '%';
    if (title) {
      if (st.phase === 'collect') title.textContent = '正在统计章节…';
      else if (st.phase === 'scan') title.textContent = '导出完成，正在扫描电子书…';
      else if (st.phase === 'dedupe') title.textContent = '正在去重书架…';
      else title.textContent = st.current ? `正在导出：${st.current}` : '准备导出…';
    }
    if (desc) {
      const chPart = totalCh ? `${doneCh.toLocaleString()} / ${totalCh.toLocaleString()} 章` : `${doneCh.toLocaleString()} 章`;
      desc.textContent = `${chPart} · 已完成 ${done}/${total} 本 · 已导出 ${(st.written || []).length} 本 · 跳过 ${(st.skipped || []).length} 本`;
    }
  };
  if (btn) btn.disabled = true;
  try {
    show();
    if (bar) bar.style.width = '0%';
    if (title) title.textContent = '准备导出…';
    if (desc) desc.textContent = '0 / 0';
    const r = await api('/export/books-txt', { method: 'POST' });
    let st = r.job || r;
    paint(st);
    label(`导出中 ${st.done || 0}/${st.total || 0}`);
    let guard = 0;
    while (st && st.running && guard < 900) {
      await new Promise((res) => setTimeout(res, 800));
      const s2 = await api('/export/books-txt/status');
      st = s2.job || s2;
      paint(st);
      label(`导出中 ${st.done || 0}/${st.total || 0}`);
      guard++;
    }
    if (st && st.error) throw new Error(st.error);
    if (bar) bar.style.width = '100%';
    if (title) title.textContent = '导出完成';
    const n = (st.written || []).length;
    if (desc) desc.textContent = `共导出 ${(st.chapters || 0).toLocaleString()} 章 · ${n} 本 · 跳过 ${(st.skipped || []).length} 本（无缓存）`;
    toast(`已导出 ${n} 本到 ebook 目录，已自动扫描并去重`);
    setTimeout(() => { if (box) box.style.display = 'none'; }, 8000);
    return st;
  } catch (e) {
    if (title) title.textContent = '导出失败';
    if (desc) desc.textContent = String(e.message || e);
    toast('导出失败：' + e.message);
    throw e;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '导出全部 TXT';
    }
  }
}

async function showDocs() {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.innerHTML = `
    <h3 style="margin-bottom:10px">软件协议总线说明</h3>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <select id="doc-pick" style="flex:1;font-size:12px"></select>
      <button class="btn" id="doc-open" style="padding:5px 10px;font-size:12px">在 GitHub 打开</button>
    </div>
    <div id="doc-body" class="doc-body" style="max-height:62vh;overflow:auto;font-size:13px;line-height:1.7">正在加载…</div>
    <div class="modal-actions"><button class="btn primary" id="doc-ok">关闭</button></div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#doc-ok').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  const list = await api('/docs').catch(() => ({ docs: [] }));
  const docs = list.docs || [];
  const pick = $('#doc-pick');
  pick.innerHTML = docs.map((d) => `<option value="${esc(d.name)}">${esc(d.title)}</option>`).join('');
  const preferred = docs.find((d) => /APP同步接口/.test(d.name)) || docs[0];
  if (preferred) pick.value = preferred.name;
  $('#doc-open').onclick = () =>
    window.open('https://github.com/TZYLXS/FnReader/blob/main/docs/' + encodeURIComponent(pick.value), '_blank', 'noopener');

  const render = async () => {
    const body = $('#doc-body');
    if (!body) return;
    body.innerHTML = '正在加载…';
    try {
      const r = await api('/docs?html=1&name=' + encodeURIComponent(pick.value));
      body.innerHTML = r.html || '<div class="empty">空文档</div>';
    } catch (e) {
      body.innerHTML = `<div style="color:var(--danger)">读取失败：${esc(e.message)}</div>`;
    }
  };
  pick.onchange = render;
  await render();
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
          <select class="scope-select theme-select" id="set-theme">${themeSelectOptions(cfg.theme)}</select>
        </div>
        <div class="row"><div class="label">字号</div>
          <input type="number" id="set-font" min="14" max="30" value="${cfg.fontSize}" style="width:72px" />
        </div>
        <div class="row"><div class="label">行距</div>
          <input type="number" id="set-lh" min="1.3" max="2.6" step="0.05" value="${cfg.lineHeight}" style="width:72px" />
        </div>
        <div class="row"><div class="label">书城兜底<div class="desc">缺封面/简介/评分时自动补全：出版物查亚马逊，网文查起点/晋江（仅 Kindle/亚马逊主题显示评分）</div></div>
          <div class="switch ${cfg.metaFallback !== false ? 'on' : ''}" id="sw-meta"></div></div>
        <div class="row"><div class="label">液态玻璃底栏<div class="desc">底栏改为半透明玻璃质感，随主题自动适配</div></div>
          <div class="switch ${cfg.liquidGlass ? 'on' : ''}" id="sw-glass"></div></div>
      </div>
      <div class="section">
        <h3>TRE 引擎</h3>
        <div class="row"><div class="label">Python 引擎<div class="desc" id="engine-status">检测中…</div></div>
          <div class="switch" id="sw-engine"></div></div>
        <div class="row"><div class="label">Java 目录引擎<div class="desc" id="java-status">检测中…</div></div>
          <div class="switch ${cfg.javaEngine !== false ? 'on' : ''}" id="sw-java"></div></div>
        <div class="row"><div class="label">运行环境<div class="desc" id="engine-runtime">检测中…</div></div></div>
        <div class="row"><div class="label">Python 工作模式<div class="desc" id="pymode-desc">检测中…</div></div>
          <div class="switch" id="sw-pymode"></div></div>
        <div class="row"><div class="label">TRE 代理解析<div class="desc">EPUB / MOBI 交给在线设备解析（关闭则只用本机）</div></div>
          <div class="switch ${cfg.treProxy !== false ? 'on' : ''}" id="sw-tre-proxy"></div></div>
        <div class="row"><div class="label">电子书解析<div class="desc" id="stat-ebook-mode">-</div></div>
          <select id="set-ebook-mode" style="max-width:46%;font-size:12px">
            <option value="proxy">代理解析（手机优先）</option>
            <option value="local">仅本机解析</option>
            <option value="off">关闭</option>
          </select>
        </div>
        <div class="row"><div class="label">扫描目录<div class="desc" id="stat-ebook">检查本地 epub/mobi/txt/pdf</div></div>
          <button class="btn" id="scan-ebook" style="padding:5px 10px;font-size:12px">立即扫描</button>
        </div>
      </div>
      <div class="section">
        <h3>手机接入</h3>
        <div class="row row-url compact">
          <div class="row-inline">
            <div class="desc" id="api-base" style="flex:1">-</div>
            <button class="btn" id="copy-base" style="padding:4px 9px;font-size:12px">复制</button>
          </div>
        </div>
        <div class="row row-url compact">
          <div class="row-inline">
            <div class="desc" id="api-alts" style="flex:1">-</div>
            <button class="btn" id="copy-alts" style="padding:4px 9px;font-size:12px">复制</button>
          </div>
        </div>
        <div class="row row-url compact" id="row-ipv6" style="display:none">
          <div class="row-inline">
            <div class="desc" id="api-ipv6" style="flex:1">-</div>
            <button class="btn" id="copy-ipv6" style="padding:4px 9px;font-size:12px">复制</button>
          </div>
        </div>
        <div class="row"><div class="label">访问令牌<div class="desc" id="api-token" style="word-break:break-all">-</div></div>
          <button class="btn" id="copy-token" style="padding:5px 10px;font-size:12px">复制</button>
          <button class="btn ghost" id="reset-token" style="padding:5px 8px;font-size:12px;color:var(--danger)">重置</button></div>
      </div>
      <div class="section">
        <h3>下载</h3>
        <a class="row" href="#/offline" style="text-decoration:none"><div class="label">已下载书籍<div class="desc" id="stat-dl">-</div></div><span style="color:var(--text-2)">›</span></a>
        <div class="row"><div class="label">保存位置<div class="desc" id="stat-dir">-</div></div>
          <select id="set-dir" style="max-width:46%;font-size:12px"></select>
        </div>
        <div class="row"><div class="label">自定义目录<div class="desc">填绝对路径，如 /vol1/1000/Books</div></div>
          <input id="set-dir-custom" placeholder="/vol1/1000/Books" style="max-width:44%;font-size:12px" />
          <button class="btn" id="save-dir-custom" title="保存自定义目录" style="padding:4px 10px;font-size:15px;line-height:1">💾</button>
        </div>
      </div>
      <div class="section">
        <h3>数据</h3>
        <div class="row"><div class="label">书源数量<div class="desc" id="stat-src">-</div></div></div>
        <div class="row"><div class="label">书籍数量<div class="desc" id="stat-book">-</div></div></div>
        <div class="row"><div class="label">搜索缓存<div class="desc" id="stat-cache">-</div></div><button class="btn" id="clear-cache" style="padding:5px 10px;font-size:12px">清空</button></div>
        <a class="row" href="#/offline" style="text-decoration:none"><div class="label">离线缓存<div class="desc" id="stat-ebook-count">-</div></div><span style="color:var(--text-2)">›</span></a>
        <div class="row"><div class="label">导出日志<div class="desc">含版本、配置、书源/电子书统计、最近运行日志（JSON）</div></div>
          <button class="btn" id="export-logs" style="padding:5px 10px;font-size:12px">导出 .json</button></div>
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
        <div class="row" id="open-docs" style="cursor:pointer"><div class="label">软件协议总线说明<div class="desc">随包文档</div></div><span style="color:var(--text-2)">›</span></div>
        <div class="row"><div class="label">刷新封面<div class="desc">清掉封面缓存并重新抓取一次</div></div>
          <button class="btn" id="refresh-covers" style="padding:5px 10px;font-size:12px">刷新</button></div>
        <div class="row row-url compact"><div class="label" style="margin-bottom:2px">书源导入</div>
          <div class="desc" id="apk-src-link">-</div></div>
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
    const docsRow = $('#open-docs');
    if (docsRow) docsRow.onclick = () => showDocs();

    const swTre = $('#sw-tre-proxy');
    if (swTre) {
      swTre.onclick = async () => {
        const next = !(swTre.classList.contains('on'));
        swTre.classList.toggle('on', next);
        try {
          await saveConfig({ treProxy: next });
          toast(next ? 'TRE 代理解析已开启（EPUB/MOBI 交给手机）' : 'TRE 代理解析已关闭（只用本机）');
        } catch (e) {
          swTre.classList.toggle('on', !next);
          toast('设置失败：' + e.message);
        }
      };
    }

    const refreshCovers = $('#refresh-covers');
    if (refreshCovers) {
      refreshCovers.onclick = async () => {
        refreshCovers.disabled = true;
        refreshCovers.textContent = '刷新中…';
        try {
          const r = await api('/covers/refresh', { method: 'POST' });
          state.coverVer = Date.now();
          toast(`封面已刷新（清理 ${r.cleared || 0} 个缓存）`);
          if (location.hash.startsWith('#/shelf')) renderShelf();
        } catch (e) {
          toast('刷新失败：' + e.message);
        } finally {
          refreshCovers.disabled = false;
          refreshCovers.textContent = '刷新';
        }
      };
    }

    $('#set-theme').onchange = (e) => saveConfig({ theme: e.target.value });
    $('#set-font').onchange = (e) => saveConfig({ fontSize: Number(e.target.value) || 19 });
    $('#set-lh').onchange = (e) => saveConfig({ lineHeight: Number(e.target.value) || 1.85 });

    const [{ sources }, { books }] = await Promise.all([api('/sources'), api('/books')]);
    $('#stat-src').textContent = `${sources.length} 个（${sources.filter((s) => s.enabled).length} 个启用）`;
    $('#stat-book').textContent = `${books.length} 本`;

    // 离线缓存统计（数据区 → #/offline）
    try {
      const off = await api('/offline');
      const el = $('#stat-ebook-count');
      if (el) el.textContent = `在线 ${off.books} 本 · 电子书 ${off.ebooks} 本 · 共 ${off.total} 本`;
    } catch {
      /* 老服务端 */
    }

    const logBtn = $('#export-logs');
    if (logBtn) {
      logBtn.onclick = async () => {
        logBtn.disabled = true;
        logBtn.textContent = '导出中…';
        try {
          const resp = await fetch('./api/logs/export?download=1');
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const cd = resp.headers.get('Content-Disposition') || '';
          const m = /filename="([^"]+)"/.exec(cd);
          a.download = m ? m[1] : 'legado-log.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          toast('日志已导出');
        } catch (e) {
          toast('导出失败：' + e.message);
        } finally {
          logBtn.disabled = false;
          logBtn.textContent = '导出 .json';
        }
      };
    }

    const exportBtn = $('#export-books');
    if (exportBtn) exportBtn.onclick = () => exportAllTxt(exportBtn).catch(() => {});

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

    // 解析引擎切换（Node 内置 / Python legado_rule）
    const swEngine = $('#sw-engine');
    const stEngine = $('#engine-status');
    if (swEngine) {
      const rt = $('#engine-runtime');
      api('/engine')
        .then((r) => {
          if (rt && r.node) {
            rt.textContent = `Node ${r.node.version || '-'} · V8 ${(r.node.v8 || '').split('-')[0] || '-'}` + (r.node.compileCache ? ' · 编译缓存已启用' : '');
          } else if (rt) {
            rt.textContent = '未知';
          }
        })
        .catch(() => {
          if (rt) rt.textContent = '未知';
        });
      const swPyMode = $('#sw-pymode');
      const pyDesc = $('#pymode-desc');
      const applyEngineState = (r) => {
        const master = r.engineSwitch === 'python';
        const core = r.pyMode === 'core';
        // 引擎开关永远可点（不灰）；切到「解析模式」时引擎显示为关
        swEngine.classList.toggle('on', master);
        swEngine.classList.remove('disabled');
        if (swPyMode) {
          swPyMode.classList.toggle('on', core);
          // 只有「引擎关闭」才把模式灰掉
          swPyMode.classList.toggle('disabled', !master && !core);
        }
        if (stEngine) {
          if (r.python && r.python.starting) stEngine.textContent = 'Python 启动中…（不影响开关操作）';
          else if (master) stEngine.textContent = '已启用 · Python ' + ((r.python && r.python.engine) || '') + (core ? '（接管规则解析）' : '（仅辅助：下载/去重）');
          else if (r.python && r.python.ok) stEngine.textContent = '内置 Node 引擎（Python 可用：' + (r.python.engine || '') + '）';
          else stEngine.textContent = '内置 Node 引擎 · Python 不可用：' + ((r.python && r.python.error) || '未安装');
        }
        const stJava = $('#java-status');
        if (stJava) {
          const j = r.java || {};
          if (j.starting) stJava.textContent = '启动中…（引擎后台拉起，稍候自动刷新）';
          else if (r.javaEngine === false) stJava.textContent = '已关闭 · 目录由 Node 处理';
          else if (j.ok) stJava.textContent = '运行中 · Java ' + (j.java || '21') + (j.virtualThreads ? ' · 虚拟线程' : '') + ` · 端口 ${j.port || '-'}`;
          else stJava.textContent = '启动失败：' + (j.lastError || j.error || 'Java 不可用');
        }
        if (pyDesc) {
          if (core) pyDesc.textContent = '开：接管 Node 规则解析（搜索 / 目录 / 正文）';
          else if (master) pyDesc.textContent = '关：接管 TXT 下载 / 去重，不接管 Node 解析';
          else pyDesc.textContent = 'Python 引擎已关闭，工作模式不可用';
        }
      };
      api('/engine')
        .then((r) => {
          applyEngineState(r);
        })
        .catch(() => {
          stEngine.textContent = '状态未知';
        });
      swEngine.onclick = async () => {
        const on = swEngine.classList.contains('on');
        stEngine.textContent = '切换中…';
        try {
          await api('/engine', { method: 'POST', body: { engine: on ? 'node' : 'python' } });
          toast(on ? '已关闭 Python 引擎（工作模式自动灰显）' : '已开启 Python 引擎');
          applyEngineState(await api('/engine'));
          setTimeout(async () => { try { applyEngineState(await api('/engine')); } catch { /* ignore */ } }, 2500);
        } catch (e) {
          stEngine.textContent = e.message;
          toast(e.message);
        }
      };
      const swJava = $('#sw-java');
      if (swJava) {
        swJava.onclick = async () => {
          const next = !swJava.classList.contains('on');
          const st = $('#java-status');
          if (st) st.textContent = next ? '启动中…' : '关闭中…';
          try {
            await api('/engine', { method: 'POST', body: { javaEngine: next } });
            swJava.classList.toggle('on', next);
            toast(next ? 'Java 目录引擎已启动' : 'Java 目录引擎已关闭，目录回落到 Node');
            applyEngineState(await api('/engine'));
            setTimeout(async () => { try { applyEngineState(await api('/engine')); } catch { /* ignore */ } }, 2500);
          } catch (e) {
            swJava.classList.toggle('on', !next);
            toast(e.message);
            applyEngineState(await api('/engine').catch(() => ({})));
          }
        };
      }
      if (swPyMode) {
        swPyMode.onclick = async () => {
          if (swPyMode.classList.contains('disabled')) return toast('Python 引擎已关闭，工作模式不可用');
          const next = swPyMode.classList.contains('on') ? 'aux' : 'core';
          try {
            await api('/engine', { method: 'POST', body: { pyMode: next } });
            toast(next === 'core' ? '工作模式：接管规则解析（搜索/目录/正文）' : '工作模式：只做辅助（TXT 下载 / 去重）');
            applyEngineState(await api('/engine'));
          } catch (e) {
            toast('切换失败：' + e.message);
          }
        };
      }
    }

    const swMeta = $('#sw-meta');
    if (swMeta)
      swMeta.onclick = () => {
        const on = !swMeta.classList.contains('on');
        swMeta.classList.toggle('on', on);
        saveConfig({ metaFallback: on });
        toast(on ? '已开书城兜底：缺封面/简介/评分时会自动补全' : '已关闭书城兜底');
      };

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
      const others = (cfg.lanIps || []).filter((x) => x !== apiBase);
      const v6 = (cfg.ipv6Lans || []).filter((x) => !String(x).includes('::1]'));
      altEl.textContent = others.join('  ') || '—';
      const ca = document.getElementById('copy-alts');
      if (ca) ca.onclick = () => copy(others.join('\n'), 'IPv4 地址');
      // IPv6 独占一行，单独复制按钮
      const v6El = document.getElementById('api-ipv6');
      const v6Row = document.getElementById('row-ipv6');
      if (v6Row && v6El) {
        if (v6.length) {
          v6El.textContent = v6.join('  ');
          v6Row.style.display = '';
          const cv6 = document.getElementById('copy-ipv6');
          if (cv6) cv6.onclick = () => copy(v6.join('\n'), 'IPv6 地址');
        } else {
          v6Row.style.display = 'none';
        }
      }
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
      const applyDir = async (value) => {
        try {
          await api('/config', { method: 'POST', body: { downloadDir: value } });
          toast('下载位置已更新');
          $('#stat-dir').textContent = value.replace(/^.*\//, '');
        } catch (e) {
          toast('设置失败：' + e.message);
        }
      };
      sel.onchange = () => applyDir(sel.value);
      // 电子书解析模式：proxy / local / off
      try {
        const es = await api('/ebook/settings');
        const sel2 = $('#set-ebook-mode');
        if (sel2) sel2.value = es.mode || 'proxy';
        const tip2 = $('#stat-ebook-mode');
        if (tip2) {
          const label = { proxy: '代理解析（手机优先）', local: '仅本机解析', off: '已关闭' }[es.mode || 'proxy'];
          tip2.textContent = `${label} · 本机 ${es.local} / 手机 ${es.device} / 共 ${es.total}`;
        }
        if (sel2)
          sel2.onchange = async () => {
            try {
              await api('/ebook/settings', { method: 'POST', body: { mode: sel2.value } });
              toast(sel2.value === 'proxy' ? '已开启代理解析' : sel2.value === 'local' ? '已切换为仅本机解析' : '已关闭电子书解析');
              if (tip2) {
                const label = { proxy: '代理解析（手机优先）', local: '仅本机解析', off: '已关闭' }[sel2.value];
                tip2.textContent = label;
              }
            } catch (e) {
              toast('设置失败：' + e.message);
            }
          };
      } catch {
        /* 老服务端没有该接口 */
      }

      // 扫描本地电子书目录（epub/mobi/txt/pdf）
      const scanBtn = $('#scan-ebook');
      if (scanBtn) {
        scanBtn.onclick = async () => {
          const tip = $('#stat-ebook');
          scanBtn.disabled = true;
          scanBtn.textContent = '扫描中…';
          try {
            const r = await api('/ebook/scan', { method: 'POST' });
            const list = await api('/ebook/list');
            const books = (list.books || []).length;
            if (tip) tip.textContent = `发现 ${r.found || 0}，新增 ${r.added || 0}，本地共 ${books} 本`;
            toast(`扫描完成：新增 ${r.added || 0}，失败 ${r.errors || 0}`);
          } catch (e) {
            toast('扫描失败：' + e.message);
          } finally {
            scanBtn.disabled = false;
            scanBtn.textContent = '立即扫描';
          }
        };
      }
      const customInput = $('#set-dir-custom');
      if (customInput) customInput.value = wanted || cur || '';
      const customSave = $('#save-dir-custom');
      if (customSave) customSave.onclick = () => {
        const v = (customInput.value || '').trim();
        if (!v) return toast('请填写目录');
        applyDir(v);
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
  // 安装/更新后先让用户确认缓存位置（确认后才放行软总线）
  try {
    const st = await api('/setup');
    if (st && st.needConfirm && !parseHash().params.has('setupskip')) {
      location.hash = '#/setup';
      await renderSetup();
      return;
    }
  } catch {
    /* 老版本服务端没有 /api/setup 时忽略 */
  }
  router();
  maybeShowFirstRunHelp();
  if (!parseHash().params.has('noevents')) {
    connectEvents();
    setTimeout(() => checkUpdateNotice(), 1500);
  }
})();
