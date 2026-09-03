// Turning clustered news into ten genuinely different posts.
//
// Two things stop a batch of ten from reading like ten clones of each other:
//   1. story diversity  - enforced structurally, before the model is involved
//   2. angle diversity  - each post is assigned a distinct rhetorical archetype
import { chat, extractJSON } from './llm.mjs';
import { tokenSimilarity } from './cluster.mjs';

/* ------------------------------- angles ------------------------------- */

export const ANGLES = [
  { id: 'THE_NUMBER',      brief: 'Open on the single most striking figure in the story, then say what it means.' },
  { id: 'THE_CONTRAST',    brief: 'Set two facts against each other - before vs after, promised vs delivered, claim vs reality.' },
  { id: 'THE_CONSEQUENCE', brief: 'Skip the event, lead with what actually changes for ordinary people because of it.' },
  { id: 'THE_SCENE',       brief: 'Open on one concrete, visual moment from the story, then widen to the significance.' },
  { id: 'THE_STAKES',      brief: 'Lead with what is still undecided and what happens next, and by when.' },
  { id: 'THE_REVERSAL',    brief: 'Lead with the detail that overturns the obvious assumption about this story.' },
  { id: 'THE_EXPLAINER',   brief: 'Take the one genuinely confusing thing here and make it clear in a sentence.' },
  { id: 'THE_HUMAN',       brief: 'Anchor on the specific people affected, named or precisely described. No sentimentality.' },
  { id: 'THE_QUOTE',       brief: 'Build around the most revealing thing someone actually said, quoted exactly from the brief.' },
  { id: 'THE_PATTERN',     brief: 'Place this story in the trend it belongs to - the third time, the latest in a run.' },
];

/* --------------------------- tweet mechanics --------------------------- */

/** X's weighted character count: most emoji and CJK count double. */
export function xLength(text) {
  let n = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f000;
    n += wide ? 2 : 1;
  }
  return n;
}

/** Normalise model output into something safe to paste straight into X. */
export function sanitizeTweet(raw) {
  let t = String(raw || '').trim();

  t = t.replace(/^["'“”]+|["'“”]+$/g, '');          // stray wrapping quotes
  t = t.replace(/^(tweet|post|output|text)\s*:\s*/i, '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');            // markdown bold
  t = t.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');   // markdown italic
  t = t.replace(/`{1,3}/g, '');
  t = t.replace(/https?:\/\/\S+/g, '').replace(/\bwww\.\S+/g, ''); // links: never auto-include
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/ +([,.!?;:])/g, '$1');
  return t.trim();
}

/** Trim to the limit at a sentence or word boundary rather than mid-word. */
export function fitTweet(text, limit = 280) {
  const t = sanitizeTweet(text);
  if (xLength(t) <= limit) return t;

  const sentences = t.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const s of sentences) {
    if (xLength(out + (out ? ' ' : '') + s) > limit) break;
    out += (out ? ' ' : '') + s;
  }
  if (xLength(out) >= 120) return out.trim();

  // No clean sentence break: fall back to word truncation with an ellipsis.
  const words = t.split(/\s+/);
  out = '';
  for (const w of words) {
    if (xLength(out + (out ? ' ' : '') + w) > limit - 1) break;
    out += (out ? ' ' : '') + w;
  }
  return out.trim().replace(/[,;:.]$/, '') + '…';
}

/* ------------------------------- prompts ------------------------------- */

const SYSTEM = `You write news posts for X (Twitter) that people actually stop scrolling for.

ABSOLUTE RULES - breaking any of these makes the output unusable:
- Use ONLY facts present in the supplied brief. Never invent a number, name, date, quote or causal claim.
- PRESERVE HEDGING EXACTLY. If the source says "at least three", "apparently", "reportedly",
  "according to", or "suspected", carry that qualifier over. Dropping a hedge turns a careful
  report into a false claim - "at least three hospitals" must never become "three hospitals".
- Keep attribution for contested claims: if only an official asserts something, say who asserted it.
- If the brief is too thin to support a specific post, say so via low confidence rather than padding with vagueness.
- Quotes must appear verbatim in the brief. If none does, do not use quotation marks.
- No links or URLs. No "read more". No "thread below" unless you actually supply a thread.
- Attribute at the end as an em dash plus outlet, e.g. "— Reuters".

VOICE:
- Concrete over abstract. Specific numbers, places, names beat adjectives.
- Short declarative sentences. Active voice. Plain words a 15-year-old reads without stumbling.
- Confident and neutral. Report the story; do not editorialise or moralise.
- No hype scaffolding: no "BREAKING" unless it broke in the last hour, no "you won't believe",
  no "let that sink in", no rhetorical questions to bait replies, no "Here's why that matters:".
- At most ONE emoji, and only when it carries real meaning. Zero is usually better.
- At most TWO hashtags, only genuinely-searched terms. Zero is fine.

FORMAT: main post must be under 270 characters INCLUDING the attribution.

Reply with ONLY a JSON object. No prose before or after. No code fences.`;

function postPrompt({ brief, angle, index, avoid }) {
  return `STORY BRIEF (${brief.sources.length} outlet(s) covering this):
${brief.text}

${brief.body ? `FULL ARTICLE EXTRACT:\n${brief.body}\n` : ''}
ASSIGNED ANGLE - ${angle.id}: ${angle.brief}
Commit to this angle. It is what makes post #${index} different from the others in this batch.

${avoid.length ? `Already used in this batch - do NOT echo these openings or framings:\n${avoid.map((a) => `- ${a}`).join('\n')}\n` : ''}
Primary outlet for attribution: ${brief.primarySource}

Return this exact JSON shape:
{
  "hook": "the main post, under 270 chars, ending with the attribution",
  "thread": ["optional follow-up post 1", "optional follow-up post 2"],
  "alt_text": "plain description of what an accompanying image should show, for screen readers, under 200 chars",
  "image_queries": ["specific visual subject, 2-4 words", "broader fallback subject, 1-3 words"],
  "card": {
    "kicker": "TOPIC · one or two words, uppercase",
    "headline": "8-16 word headline for a text card",
    "stat": "the single most striking short figure, e.g. '340,000' or '12 years', or empty string if none"
  },
  "hashtags": ["#Example"],
  "why_it_matters": "one sentence on the real-world significance of this story. Write about the NEWS, never about this task, the angle, or these instructions.",
  "confidence": 0.0
}

"image_queries" must describe a PHOTOGRAPHABLE SUBJECT (place, object, activity), never a person's
name and never an abstract noun - these are used to search public-domain photo libraries.`;
}

/* ---------------------------- generation ---------------------------- */

/**
 * Pick which stories become posts. Diversity is enforced structurally here, before
 * the model is ever called, on two axes:
 *   - subject: reject anything that overlaps a story already chosen, since
 *     clustering never catches every variant of the same event
 *   - outlet: widen the per-source quota in passes, so one prolific publisher
 *     cannot take every slot while better-spread stories go unused
 */
export function selectStories(ranked, count, { maxSubjectOverlap = 0.3, oneStoryPerDomain = true } = {}) {
  const chosen = [];
  const usedSources = new Map();
  const usedDomains = new Map();

  const tooSimilar = (cand) =>
    chosen.some((c) => tokenSimilarity(cand.cluster.tokens, c.cluster.tokens) > maxSubjectOverlap);

  // Each pass loosens the quotas by one. The first pass is the strict ideal —
  // one story per beat, one per outlet — and later passes only relax if the
  // day's news genuinely can't fill ten distinct domains.
  for (const pass of [1, 2, 3, 99]) {
    const domainCap = oneStoryPerDomain ? pass : 99;
    for (const cand of ranked) {
      if (chosen.length >= count) break;
      if (chosen.includes(cand) || tooSimilar(cand)) continue;

      const domain = cand.domain || 'general';
      if ((usedDomains.get(domain) || 0) >= domainCap) continue;

      const primary = [...cand.cluster.sources][0] || 'unknown';
      if ((usedSources.get(primary) || 0) >= pass) continue;

      chosen.push(cand);
      usedDomains.set(domain, (usedDomains.get(domain) || 0) + 1);
      usedSources.set(primary, (usedSources.get(primary) || 0) + 1);
    }
    if (chosen.length >= count) break;
  }

  // Last resort: if strict diversity starved the batch, relax the subject rule
  // rather than hand back fewer posts than asked for.
  if (chosen.length < count) {
    for (const cand of ranked) {
      if (chosen.length >= count) break;
      if (!chosen.includes(cand)) chosen.push(cand);
    }
  }
  return chosen;
}

/** Generate one post, with a repair retry when the model returns malformed JSON. */
export async function composePost({ brief, angle, index, avoid, llm, log }) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: postPrompt({ brief, angle, index, avoid }) },
  ];

  let parsed = null;
  let usedModel = null;

  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const { text, model } = await chat({ ...llm, messages, log });
    usedModel = model;
    parsed = extractJSON(text);

    if (!parsed) {
      log('warn', `post #${index}: unparseable JSON from ${model}, retrying with a stricter nudge`);
      messages.push({ role: 'assistant', content: text.slice(0, 400) });
      messages.push({
        role: 'user',
        content: 'That was not valid JSON. Reply with ONLY the JSON object, starting with { and ending with }. No commentary, no code fences.',
      });
    }
  }

  if (!parsed?.hook) throw new Error(`post #${index}: model never produced a usable hook`);

  const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
    .filter((h) => typeof h === 'string' && /^#\w+$/.test(h.trim()))
    .slice(0, 2);

  // Hashtags are appended to the hook in the final post, so their length has to
  // come out of the budget before the hook is trimmed — otherwise a hook fitted
  // to 275 plus two tags lands over the 280 limit.
  const tagCost = hashtags.length ? xLength(hashtags.join(' ')) + 2 : 0;
  const hook = fitTweet(parsed.hook, 278 - tagCost);

  const thread = (Array.isArray(parsed.thread) ? parsed.thread : [])
    .filter((t) => typeof t === 'string' && t.trim().length > 15)
    .slice(0, 4)
    .map((t) => fitTweet(t, 278));

  const imageQueries = (Array.isArray(parsed.image_queries) ? parsed.image_queries : [])
    .filter((q) => typeof q === 'string' && q.trim().length > 2)
    .map((q) => q.trim().slice(0, 60));

  return {
    angle: angle.id,
    hook,
    thread,
    altText: String(parsed.alt_text || '').slice(0, 220).trim(),
    imageQueries: imageQueries.length ? imageQueries : [brief.headline.split(/\s+/).slice(0, 4).join(' ')],
    card: {
      kicker: String(parsed.card?.kicker || 'NEWS').slice(0, 28).toUpperCase(),
      headline: String(parsed.card?.headline || brief.headline).slice(0, 170),
      stat: String(parsed.card?.stat || '').slice(0, 16),
    },
    hashtags,
    whyItMatters: String(parsed.why_it_matters || '').slice(0, 300).trim(),
    confidence: Number(parsed.confidence) || 0.5,
    model: usedModel,
    charCount: xLength(hook),
  };
}
