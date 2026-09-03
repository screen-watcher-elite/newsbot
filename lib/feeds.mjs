// RSS + Atom parsing with zero dependencies.
// Deliberately tolerant: real-world news feeds are messy and we only need a few fields.
import { getText } from './http.mjs';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", mdash: '—', ndash: '–', hellip: '…',
};

export function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function clean(s = '') {
  return decodeEntities(
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function attrOf(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[1]) : '';
}

/** Pull the best available image URL out of a feed entry. */
function extractImage(block) {
  // Ordered by how reliably each carries a real, article-sized photo.
  const candidates = [
    attrOf(block, 'media:content', 'url'),
    attrOf(block, 'media:thumbnail', 'url'),
    attrOf(block, 'enclosure', 'url'),
    attrOf(block, 'image', 'href'),
  ].filter(Boolean);

  for (const url of candidates) {
    if (/^https?:\/\//i.test(url) && !/\.(mp3|mp4|m4a|mpga|pdf)(\?|$)/i.test(url)) return url;
  }
  // Some feeds only embed the image inside the HTML description.
  const inline = block.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return inline && /^https?:/i.test(inline[1]) ? decodeEntities(inline[1]) : '';
}

function extractLink(block) {
  const rss = clean(firstTag(block, 'link'));
  if (/^https?:\/\//i.test(rss)) return rss;
  // Atom: <link rel="alternate" href="..."/>
  const alt = block.match(/<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i);
  if (alt) return decodeEntities(alt[1]);
  const any = attrOf(block, 'link', 'href');
  return /^https?:\/\//i.test(any) ? any : '';
}

function parseDate(block) {
  const raw =
    clean(firstTag(block, 'pubDate')) ||
    clean(firstTag(block, 'published')) ||
    clean(firstTag(block, 'updated')) ||
    clean(firstTag(block, 'dc:date'));
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** Google News titles arrive as "Real headline - The Source". Split that off. */
function splitSourceSuffix(title) {
  const m = title.match(/^(.*\S)\s+[-–—]\s+([^-–—]{2,40})$/);
  if (m && m[1].length > 25) return { title: m[1].trim(), source: m[2].trim() };
  return { title, source: '' };
}

export function parseFeed(xml, feed) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const feedTitle = clean(firstTag(xml.slice(0, 4000), 'title'));
  const out = [];

  for (const block of blocks) {
    const rawTitle = clean(firstTag(block, 'title'));
    if (!rawTitle) continue;

    const { title, source } = splitSourceSuffix(rawTitle);
    const summary = clean(
      firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content:encoded')
    ).slice(0, 900);

    out.push({
      title,
      summary,
      url: extractLink(block),
      image: extractImage(block),
      publishedAt: parseDate(block),
      source: source || feed.name || feedTitle || 'unknown',
      feedId: feed.url,
    });
  }
  return out;
}

/** Fetch every configured feed in parallel; a dead feed must never sink the run. */
export async function fetchAll(feeds, { maxAgeHours = 18, timeoutMs = 20000, log = () => {} } = {}) {
  const cutoff = Date.now() - maxAgeHours * 3600_000;

  const settled = await Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await getText(feed.url, { timeoutMs, retries: 1 });
      return parseFeed(xml, feed);
    })
  );

  const items = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const fresh = r.value.filter((it) => it.publishedAt >= cutoff && it.title.length >= 15);
      items.push(...fresh);
      log('debug', `feed ok: ${feeds[i].name} (${fresh.length}/${r.value.length} fresh)`);
    } else {
      failed.push({ feed: feeds[i].name, error: String(r.reason?.message || r.reason) });
      log('warn', `feed failed: ${feeds[i].name} - ${r.reason?.message || r.reason}`);
    }
  });

  return { items, failed };
}
