// Renders original typographic cards to PNG using the headless browser that
// already ships with Windows (Edge), or Chrome if present. Nothing to install.
//
// Why this exists: a card we generate ourselves is the only image with genuinely
// zero copyright exposure. It is also the format that performs best for text-led
// news posts on X.
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const run = promisify(execFile);

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser(configured) {
  if (configured && existsSync(configured)) return configured;
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) || null;
}

/* ------------------------------- theming ------------------------------- */
// Rotating palettes so ten cards from one run don't look like ten clones.

const THEMES = [
  { bg: 'linear-gradient(135deg,#0b1020,#16233f 60%,#1d2b4a)', accent: '#6ea8ff', fg: '#ffffff', sub: '#9fb3d1' },
  { bg: 'linear-gradient(135deg,#1a0f0a,#3a1d12 60%,#4a2617)', accent: '#ff9d5c', fg: '#fff8f3', sub: '#d8b39a' },
  { bg: 'linear-gradient(135deg,#07130f,#0f2e24 60%,#123d2e)', accent: '#4ade9a', fg: '#f2fffa', sub: '#9fd1bc' },
  { bg: 'linear-gradient(135deg,#140b1e,#2b1240 60%,#3a1857)', accent: '#c084fc', fg: '#fbf5ff', sub: '#c3aad8' },
  { bg: 'linear-gradient(135deg,#1a1206,#3d2a0c 60%,#4f3810)', accent: '#fbbf24', fg: '#fffaf0', sub: '#d6bd8a' },
  { bg: 'linear-gradient(135deg,#0d1117,#1c2430 60%,#252f3d)', accent: '#7dd3fc', fg: '#f5f9ff', sub: '#a8bccf' },
];

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Longer headlines need smaller type to stay on the card. */
function fontSizeFor(len) {
  if (len <= 45) return 68;
  if (len <= 70) return 60;
  if (len <= 100) return 52;
  if (len <= 140) return 44;
  return 38;
}

function buildHTML({ headline, kicker, source, stat, theme }) {
  const t = THEMES[theme % THEMES.length];
  const size = fontSizeFor(headline.length);

  // A big pulled number is the strongest visual hook when the story has one —
  // but only if it isn't already sitting in the headline directly beneath it.
  const digits = String(stat || '').replace(/[^\d]/g, '');
  const redundant = digits.length >= 2 && headline.replace(/[^\d]/g, '').includes(digits);
  const statBlock = stat && !redundant ? `<div class="stat">${esc(stat)}</div>` : '';

  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{width:1200px;height:675px;background:${t.bg};color:${t.fg};box-sizing:border-box;
    font-family:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
    display:flex;flex-direction:column;justify-content:center;padding:76px;overflow:hidden}
  .kicker{font-size:21px;letter-spacing:.2em;text-transform:uppercase;color:${t.accent};font-weight:600;margin-bottom:24px}
  .stat{font-size:96px;font-weight:800;line-height:1;color:${t.accent};letter-spacing:-.03em;margin-bottom:18px}
  h1{font-size:${size}px;line-height:1.13;margin:0;font-weight:700;letter-spacing:-.02em;
     display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
  .rule{width:96px;height:5px;background:${t.accent};border-radius:3px;margin:32px 0 24px}
  .src{font-size:23px;color:${t.sub};font-weight:500}
</style>
<div class="kicker">${esc(kicker)}</div>
${statBlock}
<h1>${esc(headline)}</h1>
<div class="rule"></div>
<div class="src">${esc(source)}</div>`;
}

/**
 * Render a card to `outPath` (PNG). Returns true on success, false if no browser
 * is available — never throws, because a missing card must not sink a bundle.
 */
export async function renderCard(opts, outPath, { browserPath, log = () => {} } = {}) {
  const browser = findBrowser(browserPath);
  if (!browser) {
    log('warn', 'no Edge/Chrome found - skipping generated card');
    return false;
  }

  const work = join(tmpdir(), `newsbot-card-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const htmlPath = join(work, 'card.html');

  try {
    writeFileSync(htmlPath, buildHTML(opts), 'utf8');

    // `--headless=new` plus an explicit throwaway profile is the combination that
    // reliably writes a screenshot on Windows.
    await run(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(work, 'profile')}`,
        '--window-size=1200,675',
        `--screenshot=${outPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { timeout: 45000, windowsHide: true }
    );

    return existsSync(outPath);
  } catch (err) {
    log('warn', `card render failed: ${err.message}`);
    return false;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch { /* temp cleanup is best-effort */ }
  }
}
