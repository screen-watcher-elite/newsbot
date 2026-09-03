// Durable state: what we've posted, what it cost, and a rotating log.
// Everything lives in ./state as plain JSON so it stays inspectable and portable.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATE_DIR = join(ROOT, 'state');
export const PROJECT_ROOT = ROOT;

mkdirSync(STATE_DIR, { recursive: true });

export function readJSON(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(name, value) {
  const target = join(STATE_DIR, name);
  const tmp = `${target}.tmp`;
  // Write-then-rename: a crash mid-write can't leave a corrupt state file behind.
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, target);
}

/* ------------------------------- logging ------------------------------- */

const LOG = join(STATE_DIR, 'newsbot.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function makeLogger({ verbose = false } = {}) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > MAX_LOG_BYTES) {
      renameSync(LOG, join(STATE_DIR, 'newsbot.log.1'));
    }
  } catch { /* logging must never break the run */ }

  return function log(level, msg) {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
    if (level !== 'debug' || verbose) console.log(line);
    try {
      appendFileSync(LOG, line + '\n', 'utf8');
    } catch { /* ignore */ }
  };
}

/* ---------------------------- posted stories ---------------------------- */

const SEEN_FILE = 'seen.json';

export function loadSeen(retentionDays = 7) {
  const cutoff = Date.now() - retentionDays * 86400_000;
  const all = readJSON(SEEN_FILE, []);
  const kept = Array.isArray(all) ? all.filter((e) => e.ts >= cutoff) : [];
  return {
    entries: kept,
    signatures: new Set(kept.map((e) => e.sig)),
    texts: kept.map((e) => e.text).filter(Boolean),
  };
}

/**
 * Record a posted story. Mutates `seen` in place rather than rebuilding from the
 * snapshot: posts are generated in parallel batches, and rebuilding from a stale
 * copy meant each concurrent write clobbered the previous one, so only the last
 * story in each batch was ever remembered.
 */
export function recordPost(seen, { sig, text, url }) {
  seen.entries.push({ sig, text, url, ts: Date.now() });
  seen.signatures.add(sig);
  writeJSON(SEEN_FILE, seen.entries.slice(-400));
}

/* ------------------------------ run history ------------------------------ */

export function recordRun(summary) {
  const runs = readJSON('runs.json', []);
  writeJSON('runs.json', [...(Array.isArray(runs) ? runs : []), summary].slice(-60));
}
