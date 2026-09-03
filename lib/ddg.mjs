// DuckDuckGo search, reimplemented natively in Node with zero dependencies.
//
// Same technique the open-source `ddgs` Python package uses: DuckDuckGo has no
// official search API, so we obtain a per-query `vqd` token from the HTML page
// and then call the internal JSON endpoints the DDG web UI itself calls.
//
// Consequences we design around: the token is QUERY-SPECIFIC (reusing one from a
// different query returns 403), and the endpoints rate-limit if hit hard. Every
// call therefore goes through a polite shared throttle.
import { request } from './http.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeEntities } from './feeds.mjs';

const BASE = 'https://duckduckgo.com';

/* --------------------------- polite throttling --------------------------- */
// DDG blocks bursts. Serialise every call behind a minimum gap + jitter.

let chain = Promise.resolve();
let minGapMs = 1200;

export function setThrottle(ms) {
  minGapMs = Math.max(0, ms);
}

function throttled(fn) {
  const run = chain.then(async () => {
    const out = await fn();
    await sleep(minGapMs + Math.floor(Math.random() * 500));
    return out;
  });
  // Keep the chain alive even when a link rejects.
  chain = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------ vqd tokens ------------------------------ */

const vqdCache = new Map();

const VQD_PATTERNS = [
  /vqd="([^"]+)"/,
  /vqd='([^']+)'/,
  /"vqd":"([^"]+)"/,
  /vqd=([\d-]+)&/,
  /vqd&quot;:&quot;([^&]+)&quot;/,
];

async function getVqd(query, kind = 'web') {
  const key = `${kind}:${query}`;
  if (vqdCache.has(key)) return vqdCache.get(key);

  const suffix = kind === 'images' ? '&iar=images&iax=images&ia=images' : '';
  const url = `${BASE}/?q=${encodeURIComponent(query)}${suffix}`;

  const res = await request(url, {
    timeoutMs: 20000,
    retries: 2,
    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
  });
  const html = await res.text();

  for (const pattern of VQD_PATTERNS) {
    const m = html.match(pattern);
    if (m) {
      vqdCache.set(key, m[1]);
      return m[1];
    }
  }
  throw new Error(`could not extract vqd for "${query}" (DDG may be rate-limiting)`);
}

function ddgHeaders(query, kind) {
  const ia = kind === 'images' ? '&iax=images&ia=images' : '';
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    referer: `${BASE}/?q=${encodeURIComponent(query)}${ia}`,
    'x-requested-with': 'XMLHttpRequest',
  };
}

function stripTags(s = '') {
  return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/* ------------------------------ news search ------------------------------ */

/**
 * DDG News. Returns normalised items shaped like feeds.mjs output so the two
 * sources can be merged and clustered together.
 *
 * @param {string} query
 * @param {{maxResults?:number, region?:string, timelimit?:'d'|'w'|'m'|null, safesearch?:number}} opts
 */
export async function newsSearch(query, opts = {}) {
  const { maxResults = 30, region = 'us-en', timelimit = 'd', safesearch = 1 } = opts;
  const vqd = await throttled(() => getVqd(query, 'news'));

  const out = [];
  const seenUrls = new Set();

  for (let offset = 0; out.length < maxResults && offset < 90; offset += 30) {
    const params = new URLSearchParams({
      l: region,
      o: 'json',
      noamp: '1',
      q: query,
      vqd,
      p: String(safesearch),
    });
    if (timelimit) params.set('df', timelimit);
    if (offset) params.set('s', String(offset));

    const res = await throttled(() =>
      request(`${BASE}/news.js?${params}`, { timeoutMs: 25000, retries: 1, headers: ddgHeaders(query, 'news') })
    );
    if (!res.ok) {
      if (out.length) break; // partial results beat none
      throw new Error(`DDG news ${res.status} for "${query}"`);
    }

    const body = await res.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      break;
    }

    const results = data?.results || [];
    if (!results.length) break;

    for (const r of results) {
      const url = r.url || r.link;
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      out.push({
        title: stripTags(r.title),
        summary: stripTags(r.excerpt || r.body),
        url,
        image: r.image || '',
        // DDG returns unix seconds; feeds.mjs works in millis.
        publishedAt: Number.isFinite(r.date) ? r.date * 1000 : Date.now(),
        source: stripTags(r.source) || 'DuckDuckGo News',
        origin: 'ddg-news',
        query,
      });
      if (out.length >= maxResults) break;
    }
    if (results.length < 30) break;
  }
  return out;
}

/* ----------------------------- image search ----------------------------- */

export async function imageSearch(query, opts = {}) {
  const { maxResults = 25, region = 'us-en', safesearch = 1, minWidth = 640 } = opts;
  const vqd = await throttled(() => getVqd(query, 'images'));

  const params = new URLSearchParams({
    l: region,
    o: 'json',
    q: query,
    vqd,
    p: String(safesearch),
    f: ',,,,,',
  });

  const res = await throttled(() =>
    request(`${BASE}/i.js?${params}`, { timeoutMs: 25000, retries: 1, headers: ddgHeaders(query, 'images') })
  );
  if (!res.ok) throw new Error(`DDG images ${res.status} for "${query}"`);

  const data = JSON.parse(await res.text());
  return (data?.results || [])
    .filter((r) => r.image && (r.width || 0) >= minWidth)
    .slice(0, maxResults)
    .map((r) => ({
      url: r.image,
      thumb: r.thumbnail,
      title: stripTags(r.title),
      width: r.width,
      height: r.height,
      host: r.source || '',
      provider: 'ddg-images',
      license: 'unverified',
    }));
}

/* ------------------------------ text search ------------------------------ */
// The lite HTML endpoint is more stable than the JSON one and needs no vqd,
// so it is what we use for general web lookups.

export async function textSearch(query, opts = {}) {
  const { maxResults = 15 } = opts;

  const res = await throttled(() =>
    request('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      timeoutMs: 25000,
      retries: 1,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        referer: 'https://lite.duckduckgo.com/',
      },
      body: new URLSearchParams({ q: query }).toString(),
    })
  );
  if (!res.ok) throw new Error(`DDG lite ${res.status}`);
  const html = await res.text();

  const out = [];
  const linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && out.length < maxResults) {
    let url = decodeEntities(m[1]);
    // DDG wraps some hits in a redirect shim.
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (/^https?:\/\//i.test(url)) out.push({ url, title: stripTags(m[2]) });
  }
  return out;
}
