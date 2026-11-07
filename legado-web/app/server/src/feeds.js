'use strict';
// 订阅（RSS / Atom）抓取与解析
const cheerio = require('cheerio');
const { request } = require('./util');

function textOf($, node, sel) {
  const el = $(node).find(sel).first();
  return el.text().trim();
}

function parseDate(raw) {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function parseFeed(xml, url) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const feed = { title: '', link: '', items: [] };

  if ($('feed').length) {
    // Atom
    feed.title = $('feed > title').first().text().trim();
    const selfLink = $('feed > link').first().attr('href') || '';
    feed.link = selfLink || url;
    $('entry').each((i, entry) => {
      const $e = $(entry);
      const link = $e.find('link').first().attr('href') || $e.find('id').first().text().trim();
      const summary = $e.find('summary').text().trim() || $e.find('content').text().trim();
      feed.items.push({
        title: $e.find('title').first().text().trim() || '(无标题)',
        link: link || '',
        date: parseDate($e.find('updated').text() || $e.find('published').text()),
        summary: summary.slice(0, 300),
      });
    });
  } else {
    // RSS 2.0
    const channel = $('channel').first();
    feed.title = channel.find('> title').first().text().trim() || $('title').first().text().trim();
    feed.link = channel.find('> link').first().text().trim() || url;
    const nodes = $('item');
    nodes.each((i, item) => {
      const $i = $(item);
      const link = $i.find('link').first().text().trim() || $i.find('guid').first().text().trim();
      const desc = $i.find('description').first().text().trim();
      feed.items.push({
        title: $i.find('title').first().text().trim() || '(无标题)',
        link: link || '',
        date: parseDate($i.find('pubDate').first().text()),
        summary: desc.replace(/<[^>]+>/g, '').slice(0, 300),
      });
    });
  }

  feed.items = feed.items.filter((x) => x.title || x.link).slice(0, 100);
  return feed;
}

async function fetchFeed(url) {
  const resp = await request(url, { timeout: 20000, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
  const feed = parseFeed(resp.body, resp.url || url);
  if (!feed.items.length) throw new Error('没有解析到条目，可能不是 RSS/Atom 地址');
  return { ...feed, url: resp.url || url, fetchedAt: Date.now() };
}

module.exports = { fetchFeed, parseFeed };
