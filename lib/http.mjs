// Tiny HTTP helper: timeouts, retries with backoff, sane defaults. No dependencies.
import { setTimeout as sleep } from 'node:timers/promises';

// Must stay a plain browser UA. DuckDuckGo returns 403 the moment the string
// contains a bot-like token (verified: appending "NewsBot/1.0" gets us blocked).
// Wikimedia's policy wants a descriptive UA, so that caller overrides this.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoff(attempt) {
  const base = 600 * 2 ** attempt;
  return base + Math.floor(Math.random() * 400); // jitter
}

/**
 * fetch() with a hard timeout and bounded retries.
 * Retries only on transient network errors and transient status codes.
 */
export async function request(url, opts = {}) {
  const { timeoutMs = 20000, retries = 2, ...init } = opts;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        ...init,
        signal: ac.signal,
        headers: { 'user-agent': UA, ...(init.headers || {}) },
      });

      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : backoff(attempt);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`request failed: ${url}`);
}

export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

export async function getJSON(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GET ${url} -> invalid JSON: ${body.slice(0, 200)}`);
  }
}

export async function getBuffer(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  return { buf: Buffer.from(await res.arrayBuffer()), type };
}
