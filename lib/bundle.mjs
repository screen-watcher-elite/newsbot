// Writes one self-contained folder per post: copy-ready text, images, licence
// record, and machine-readable metadata.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIERS } from './images.mjs';
import { xLength } from './compose.mjs';

/**
 * The exact text that goes in the copy block, and its true weighted length.
 * The hook alone is not the whole post — hashtags are appended here, and counting
 * only the hook understates what actually gets pasted into X.
 */
export function fullPostText(post) {
  const text = post.hook + (post.hashtags.length ? `\n\n${post.hashtags.join(' ')}` : '');
  return { text, count: xLength(text) };
}

// Windows tools (Notepad, PowerShell 5.1, Excel) still assume the legacy ANSI
// codepage for files with no BOM, which turns every em dash and emoji into
// mojibake the moment the text is copied out. A BOM makes them read UTF-8.
const BOM = '﻿';

function writeText(path, content) {
  writeFileSync(path, BOM + content, 'utf8');
}

export function slugify(text, max = 46) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'post'
  );
}

export function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function fence(text) {
  // Keep the copy block clean even if the post itself contains backticks.
  return text.includes('```') ? `~~~\n${text}\n~~~` : `\`\`\`\n${text}\n\`\`\``;
}

function postMarkdown({ post, brief, images, card, index }) {
  const { text: full, count } = fullPostText(post);

  const imageList = images.length
    ? images
        .map(
          (img, i) =>
            `${i + 1}. \`${img.filename}\` — ${TIERS[img.tier].label}` +
            (TIERS[img.tier].safe ? '' : '  ⚠️ **not cleared for publication**')
        )
        .join('\n')
    : '_No stock image matched. The generated card is the safe option._';

  const threadBlock = post.thread.length
    ? post.thread.map((t, i) => `**Reply ${i + 1}** (${xLength(t)} chars)\n\n${fence(t)}`).join('\n\n')
    : '_No thread — this one works as a single post._';

  return `# Post ${String(index).padStart(2, '0')} — ${post.card.kicker}

> **Angle:** ${post.angle} · **Confidence:** ${post.confidence.toFixed(2)} · **Model:** ${post.model}

## ✅ Copy this into X

${fence(full)}

**${count} / 280 characters** (text + hashtags)${count > 280 ? ' — ⚠️ OVER LIMIT, trim before posting' : ' — fits'}

## 🖼 Image to attach

${card ? `**Recommended:** \`${card}\` (generated card — you own it, zero copyright risk)\n` : ''}
${imageList}

### Card copy — if you'd rather design it yourself

Paste these into Canva/Figma/your template. 1200×675 px is X's optimal ratio.

| Slot | Text |
|------|------|
| Kicker | ${post.card.kicker} |
| Headline | ${post.card.headline} |
| Big stat | ${post.card.stat || '_none for this story_'} |
| Source line | ${brief.primarySource} |

**Alt text** (paste into X's image description box — improves reach and accessibility):

${fence(post.altText || 'News illustration.')}

## 🧵 Optional thread

${threadBlock}

## Why this matters

${post.whyItMatters || '_Not supplied._'}

## Sources

${brief.sourceList.map((s) => `- ${s.source} — ${s.title}${s.url ? `\n  ${s.url}` : ''}`).join('\n')}

---

<sub>Generated ${new Date().toISOString()} · Verify facts against the sources above before posting.</sub>
`;
}

function creditsMarkdown({ images, card }) {
  const rows = images.map((img) => {
    const t = TIERS[img.tier];
    return `### \`${img.filename}\`

- **Tier:** ${img.tier} — ${t.label}
- **Safe to publish:** ${t.safe ? '✅ Yes' : '❌ NO — verify rights yourself first'}
- **Attribution required:** ${t.attribution ? '⚠️ Yes' : 'No'}
- **Licence:** ${img.license}
- **Creator:** ${img.creator}
- **Provider:** ${img.provider}
- **Source page:** ${img.pageUrl || 'n/a'}
${t.attribution ? `\n**Use this credit line:**\n\n> ${img.creator}, ${img.license}${img.licenseUrl ? ` (${img.licenseUrl})` : ''}\n` : ''}`;
  });

  return `# Image credits & licensing

${card ? `### \`${card}\`

- **Tier:** A — Generated card
- **Safe to publish:** ✅ Yes — created by this tool, you hold the rights
- **Attribution required:** No
` : ''}
${rows.join('\n\n') || '_No third-party images were downloaded for this post._'}

---

## Before you post

Copyright is decided by **licence**, not by editing. Cropping, filtering or running an
image through an AI filter creates a derivative work and does **not** remove someone
else's copyright. Only post images marked ✅ above, and include the credit line where
one is required.
`;
}

/** Write a complete bundle folder. Returns the folder path. */
export function writeBundle({ runDir, index, post, brief, images, cardFile }) {
  const folder = join(runDir, `${String(index).padStart(2, '0')}-${slugify(post.card.headline || brief.headline)}`);
  mkdirSync(folder, { recursive: true });

  writeText(join(folder, 'post.md'), postMarkdown({ post, brief, images, card: cardFile, index }));
  writeText(join(folder, 'CREDITS.md'), creditsMarkdown({ images, card: cardFile }));
  writeFileSync(
    join(folder, 'meta.json'),
    JSON.stringify(
      {
        index,
        angle: post.angle,
        generatedAt: new Date().toISOString(),
        model: post.model,
        confidence: post.confidence,
        charCount: post.charCount,
        text: post.hook,
        hashtags: post.hashtags,
        thread: post.thread,
        altText: post.altText,
        card: cardFile || null,
        images: images.map((i) => ({
          file: i.filename,
          tier: i.tier,
          safeToPublish: TIERS[i.tier].safe,
          license: i.license,
          creator: i.creator,
          provider: i.provider,
          sourcePage: i.pageUrl,
        })),
        sources: brief.sourceList,
      },
      null,
      2
    ),
    'utf8'
  );

  return folder;
}

/** Run-level index so ten folders are reviewable at a glance. */
export function writeIndex({ runDir, results, stats }) {
  // A post can be within the character limit and still be empty of information.
  // Short and free of any concrete number or named entity is the usual signature
  // of a story that had no real reporting behind it.
  const thin = (r) => r.post.charCount < 120 && !/\d/.test(r.post.hook);

  const rows = results
    .map((r) => {
      const { count } = fullPostText(r.post);
      const flag = count > 280 ? '⚠️ over' : thin(r) ? '⚠️ thin' : '✅';
      const imgs = (r.cardFile ? 1 : 0) + r.images.length;
      const preview = r.post.hook.replace(/\s+/g, ' ').slice(0, 76).replace(/\|/g, '\\|');
      return `| ${String(r.index).padStart(2, '0')} | ${r.post.domain || '—'} | ${r.post.angle} | ${flag} ${count} | ${imgs} | ${preview}… |`;
    })
    .join('\n');

  const thinCount = results.filter(thin).length;

  const md = `# News post batch — ${new Date().toLocaleString()}

**${results.length} posts ready.** Each folder holds \`post.md\` (copy-ready text),
its images, and \`CREDITS.md\` (licence record).

| # | Domain | Angle | Chars | Imgs | Preview |
|---|--------|-------|-------|------|---------|
${rows}
${thinCount ? `\n> ⚠️ ${thinCount} post(s) marked **thin** — the source story had little substance. Consider skipping those.\n` : ''}

## Run stats

- Articles gathered: **${stats.gathered}**
- Distinct stories found: **${stats.clusters}**
- Articles scraped in full: **${stats.scraped}**
- Sources reached: **${stats.sources}**
- Model(s) used: ${stats.models.join(', ') || 'n/a'}
- Duration: **${stats.durationSec}s**
${stats.failures.length ? `\n### Warnings\n\n${stats.failures.map((f) => `- ${f}`).join('\n')}` : ''}

---

⚠️ **Check before posting:** these are AI-written summaries of scraped articles.
Verify facts against the linked sources, and only attach images marked ✅ in \`CREDITS.md\`.
`;

  writeText(join(runDir, 'INDEX.md'), md);
}
