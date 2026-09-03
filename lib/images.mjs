// License-aware image sourcing.
//
// Images are graded into tiers and the config decides how far down the tiers we
// are willing to go. Tier D exists because it is occasionally useful for private
// reference, but it is off by default: news-wire photos are the most aggressively
// DMCA-enforced images on social platforms.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJSON, getBuffer } from './http.mjs';
import { imageSearch as ddgImages } from './ddg.mjs';

export const TIERS = {
  A: { label: 'Generated card', safe: true, attribution: false },
  B: { label: 'Public domain / CC0', safe: true, attribution: false },
  C: { label: 'Creative Commons (attribution required)', safe: true, attribution: true },
  D: { label: 'Rights unverified', safe: false, attribution: true },
};

/* ------------------------------- Openverse ------------------------------- */
// No API key required. Restricted to CC0 + Public Domain Mark so the results
// carry no attribution obligation at all.

async function openverse(query, { limit = 6, log = () => {} } = {}) {
  const url =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&license=cc0,pdm&page_size=${limit}&mature=false&size=medium,large`;
  try {
    const data = await getJSON(url, { timeoutMs: 20000, retries: 1 });
    return (data?.results || []).map((r) => ({
      url: r.url,
      title: r.title || query,
      width: r.width,
      height: r.height,
      provider: `Openverse / ${r.source || 'unknown'}`,
      creator: r.creator || 'Unknown',
      license: (r.license || 'cc0').toUpperCase(),
      licenseUrl: r.license_url || 'https://creativecommons.org/publicdomain/zero/1.0/',
      pageUrl: r.foreign_landing_url || r.url,
      tier: 'B',
    }));
  } catch (err) {
    log('debug', `openverse failed for "${query}": ${err.message}`);
    return [];
  }
}

/* ---------------------------- Wikimedia Commons ---------------------------- */

async function wikimedia(query, { limit = 6, log = () => {} } = {}) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}` +
    '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600';
  try {
    const data = await getJSON(url, {
      timeoutMs: 20000,
      retries: 1,
      headers: { 'user-agent': 'NewsBot/1.0 (personal news summariser)' },
    });
    const pages = Object.values(data?.query?.pages || {});
    return pages
      .map((p) => {
        const info = p.imageinfo?.[0];
        if (!info) return null;
        const meta = info.extmetadata || {};
        const licence = (meta.LicenseShortName?.value || 'unknown').replace(/<[^>]+>/g, '');
        const publicDomain = /public domain|^pd|cc0/i.test(licence);
        return {
          url: info.thumburl || info.url,
          title: (p.title || '').replace(/^File:/, ''),
          width: info.thumbwidth || info.width,
          height: info.thumbheight || info.height,
          provider: 'Wikimedia Commons',
          creator: String(meta.Artist?.value || 'Unknown').replace(/<[^>]+>/g, '').trim().slice(0, 120),
          license: licence,
          licenseUrl: meta.LicenseUrl?.value || 'https://commons.wikimedia.org/',
          pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || '')}`,
          tier: publicDomain ? 'B' : 'C',
        };
      })
      .filter(Boolean);
  } catch (err) {
    log('debug', `wikimedia failed for "${query}": ${err.message}`);
    return [];
  }
}

/* ------------------------------ Tier D (opt-in) ------------------------------ */

async function unverified(query, { limit = 6, log = () => {} } = {}) {
  try {
    const results = await ddgImages(query, { maxResults: limit, minWidth: 800 });
    return results.map((r) => ({
      url: r.url,
      title: r.title,
      width: r.width,
      height: r.height,
      provider: `Web (${r.host})`,
      creator: r.host || 'Unknown',
      license: 'UNVERIFIED - do not publish without checking',
      licenseUrl: '',
      pageUrl: r.url,
      tier: 'D',
    }));
  } catch (err) {
    log('debug', `ddg images failed for "${query}": ${err.message}`);
    return [];
  }
}

/* ------------------------------- download ------------------------------- */

/** Identify real format from magic bytes; never trust the extension or header. */
function sniffFormat(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null; // webp / avif / gif / svg deliberately rejected
}

/**
 * Download candidates until `want` valid JPEG/PNG files are saved.
 * Anything that isn't genuinely a JPEG or PNG is dropped, which guarantees every
 * file in a bundle is directly uploadable to X.
 */
export async function downloadImages(candidates, { dir, want = 2, minBytes = 12000, prefix = 'image', log = () => {} }) {
  const saved = [];

  for (const cand of candidates) {
    if (saved.length >= want) break;
    try {
      const { buf } = await getBuffer(cand.url, { timeoutMs: 25000, retries: 1 });
      const fmt = sniffFormat(buf);
      if (!fmt) {
        log('debug', `skip (not jpg/png): ${cand.url.slice(0, 90)}`);
        continue;
      }
      if (buf.length < minBytes) {
        log('debug', `skip (too small, ${buf.length}B): ${cand.url.slice(0, 90)}`);
        continue;
      }
      if (buf.length > 5 * 1024 * 1024) {
        log('debug', `skip (over X's 5MB limit): ${cand.url.slice(0, 90)}`);
        continue;
      }

      const filename = `${prefix}-${saved.length + 1}.${fmt}`;
      writeFileSync(join(dir, filename), buf);
      saved.push({ ...cand, filename, bytes: buf.length, format: fmt });
      log('debug', `saved ${filename} (${(buf.length / 1024).toFixed(0)}KB, tier ${cand.tier})`);
    } catch (err) {
      log('debug', `download failed: ${err.message}`);
    }
  }
  return saved;
}

/* --------------------------- quality filtering --------------------------- */
// Public-domain corpora are dominated by scanned books, report covers and
// archival plates. They match keywords well and look terrible attached to a news
// post, so they get filtered on shape and provenance before anything downloads.

const ARCHIVAL_SIGNALS =
  /internet archive|biodiversity heritage|book image|scanned|herbarium|patent|annual report|proceedings|bulletin|gazette|manuscript|title page|plate \d|figure \d|impact statement|survey of|catalogue/i;

const DOCUMENT_TITLE =
  /\breport\b|\bstatement\b|\bproceedings\b|\bvolume\b|\bpage\b|\bplate\b|\bmap of\b|\bchart\b|\bdiagram\b|\bcover\b|\bletter\b|\bform \d/i;

function qualityScore(img) {
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (!w || !h) return 0.5; // unknown dimensions: neither reward nor reject

  const ratio = w / h;
  let score = 1;

  // X crops to landscape. Portrait images are usually document scans anyway.
  if (ratio < 0.95) score -= 0.6;
  else if (ratio >= 1.3 && ratio <= 2.1) score += 0.4; // close to 16:9
  if (w < 800) score -= 0.3;
  if (w >= 1200) score += 0.2;

  const haystack = `${img.title || ''} ${img.provider || ''} ${img.creator || ''}`;
  if (ARCHIVAL_SIGNALS.test(haystack)) score -= 1.2;
  if (DOCUMENT_TITLE.test(img.title || '')) score -= 0.5;

  return score;
}

/**
 * Collect candidates across every allowed tier, best-licensed first.
 * `queries` should run from most specific to most generic so we degrade to a
 * usable generic image rather than to nothing.
 */
export async function findImages(queries, { policy = 'safe', perQuery = 5, log = () => {} } = {}) {
  const allowD = policy === 'any';
  const out = [];
  const seen = new Set();

  for (const query of queries) {
    if (!query) continue;
    const batches = await Promise.all([
      openverse(query, { limit: perQuery, log }),
      wikimedia(query, { limit: perQuery, log }),
      allowD ? unverified(query, { limit: perQuery, log }) : Promise.resolve([]),
    ]);

    for (const item of batches.flat()) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push({ ...item, matchedQuery: query });
    }
    // Enough breadth to survive download rejections without over-fetching.
    if (out.filter((i) => i.tier !== 'D').length >= 12) break;
  }

  const order = { B: 0, C: 1, D: 2 };
  const scored = out
    .map((img) => ({ ...img, quality: qualityScore(img) }))
    .filter((img) => img.quality > -0.2); // drop obvious document scans outright

  // Licence tier still leads — a usable photo we can't publish is worth less than
  // a plainer one we can — but quality decides the order within a tier.
  return scored.sort((a, b) => order[a.tier] - order[b.tier] || b.quality - a.quality);
}
