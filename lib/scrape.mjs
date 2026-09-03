// Article scraping: pull the real body text out of a news page so the model
// writes from substance rather than from a one-line headline.
// Readability-style heuristics, no dependencies.
import { request } from './http.mjs';
import { decodeEntities } from './feeds.mjs';

function meta(html, ...names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      'i'
    );
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]).trim();
    // Attribute order varies between publishers.
    const re2 = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
      'i'
    );
    const m2 = html.match(re2);
    if (m2?.[1]) return decodeEntities(m2[1]).trim();
  }
  return '';
}

/** Strip everything that never contains article prose. */
function stripChrome(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|figure|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Extract body text by scoring <p> tags. Real article paragraphs are long and
 * sentence-shaped; navigation and boilerplate are short and link-dense.
 */
function extractBody(html, maxChars) {
  const cleaned = stripChrome(html);
  const paras = cleaned.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];

  const good = paras
    .map((p) => {
      const links = (p.match(/<a\b/gi) || []).length;
      const text = decodeEntities(p.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      return { text, links };
    })
    .filter(({ text, links }) => {
      if (text.length < 60) return false;
      if (links > 2 && text.length < 200) return false; // link list, not prose
      if (!/[.!?]/.test(text)) return false;
      if (/^(share|advertisement|subscribe|sign up|copyright|read more|follow us)/i.test(text)) return false;
      return true;
    })
    .map((p) => p.text);

  let out = '';
  for (const p of good) {
    if (out.length + p.length > maxChars) break;
    out += (out ? '\n\n' : '') + p;
  }
  return out;
}

/**
 * Fetch and parse one article. Never throws — a failed scrape just means we fall
 * back to the feed/search excerpt for that item.
 */
export async function scrapeArticle(url, { maxChars = 2600, timeoutMs = 20000, log = () => {} } = {}) {
  try {
    const res = await request(url, {
      timeoutMs,
      retries: 1,
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') || '';
    if (!/text\/html/i.test(type)) return null;

    const html = (await res.text()).slice(0, 900_000);

    return {
      url,
      title: meta(html, 'og:title', 'twitter:title') || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()),
      description: meta(html, 'og:description', 'twitter:description', 'description'),
      image: meta(html, 'og:image', 'twitter:image', 'twitter:image:src'),
      siteName: meta(html, 'og:site_name'),
      publishedAt: meta(html, 'article:published_time', 'publishdate', 'date'),
      body: extractBody(html, maxChars),
    };
  } catch (err) {
    log('debug', `scrape failed ${url.slice(0, 70)}: ${err.message}`);
    return null;
  }
}

/** Bounded-concurrency map — polite to publishers, still fast. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
