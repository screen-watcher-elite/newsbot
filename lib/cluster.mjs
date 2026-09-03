// Group the same story across outlets, then score which story is worth posting.
// The core signal: a story covered by many independent outlets is a big story.

const STOPWORDS = new Set(
  ('a an the and or but of in on at to for from by with as is are was were be been being it its this that these those ' +
   'he she they them his her their we you i us our your not no if then than so such about into over under after before ' +
   'new latest says say said report reports update updates live breaking news video watch photos amid may will can could ' +
   'would should has have had do does did more most other some what which who whom how why when where')
    .split(' ')
);

/** Title -> set of meaningful tokens used for both matching and dedupe. */
export function tokenize(text) {
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function shared(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Similarity between two headlines.
 *
 * Plain Jaccard punishes headline pairs of different lengths: "'Probably my last
 * year' - Ronaldo hints at retirement" vs "Cristiano Ronaldo Hints at Retirement
 * After His Final World Cup..." scores only 0.23 and stays split. The overlap
 * coefficient (shared / smaller set) catches that case at 0.5, so we take the
 * better of the two and require an absolute floor of 3 shared tokens to stop
 * short headlines from matching on coincidence.
 */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  const n = shared(a, b);
  if (n < 3) return 0;
  const jaccard = n / (a.size + b.size - n);
  const overlap = n / Math.min(a.size, b.size);
  return Math.max(jaccard, overlap * 0.78);
}

/** Exposed so post selection can reject two near-duplicate stories in one batch. */
export function tokenSimilarity(a, b) {
  return similarity(a, b);
}

/** Stable identity for a story, so we never post the same event twice. */
export function signature(tokens) {
  return [...tokens].sort().slice(0, 8).join('|');
}

/**
 * Greedy single-pass clustering. O(n*k) where k = cluster count.
 * Fine for the few hundred items an hourly run sees.
 */
export function clusterItems(items, threshold = 0.34) {
  const clusters = [];

  for (const item of items) {
    const tokens = tokenize(item.title);
    if (tokens.size < 3) continue;

    // Compare against individual member headlines rather than a merged token
    // union. A union drifts as it grows and starts swallowing unrelated stories.
    let best = null;
    let bestScore = threshold;
    for (const c of clusters) {
      let score = 0;
      for (const member of c.members) {
        const s = similarity(tokens, member);
        if (s > score) score = s;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) {
      best.items.push(item);
      best.sources.add(item.source);
      if (item.image && !best.image) best.image = item.image;
      if (best.members.length < 4) best.members.push(tokens);
      for (const t of tokens) best.tokens.add(t);
    } else {
      clusters.push({
        tokens: new Set(tokens),
        members: [tokens],
        items: [item],
        sources: new Set([item.source]),
        image: item.image || '',
      });
    }
  }
  return clusters;
}

/**
 * Score = breadth of coverage (dominant) + freshness + having a usable image.
 * Breadth uses distinct sources, so one outlet spamming 5 updates can't win alone.
 */
export function scoreCluster(cluster, now = Date.now()) {
  const breadth = cluster.sources.size;
  const newest = Math.max(...cluster.items.map((i) => i.publishedAt));
  const ageHours = Math.max(0, (now - newest) / 3600_000);

  const breadthScore = Math.log2(breadth + 1) * 10;
  const freshScore = Math.max(0, 8 - ageHours * 1.4);
  const imageScore = cluster.image ? 2 : 0;
  const depthScore = Math.min(cluster.items.length, 6) * 0.5;

  // Substance guard. A lone outlet with a two-line blurb produces an empty post
  // however good the writing prompt is — the model has nothing to work with. The
  // penalty pushes those below any story with real reporting behind it.
  const bestSummary = Math.max(0, ...cluster.items.map((i) => (i.summary || '').length));
  const substanceScore = Math.min(bestSummary / 120, 4);
  const thinPenalty = breadth === 1 && bestSummary < 180 ? 8 : 0;

  return breadthScore + freshScore + imageScore + depthScore + substanceScore - thinPenalty;
}

/** Rank clusters, skipping anything already posted and anything too thin. */
export function pickStory(items, { seenSignatures = new Set(), minSources = 1, blockedPatterns = [] } = {}) {
  const blocked = blockedPatterns.map((p) => new RegExp(p, 'i'));
  const usable = items.filter((it) => !blocked.some((re) => re.test(it.title)));

  const scored = clusterItems(usable)
    .map((c) => ({
      cluster: c,
      // Signature comes from the seed headline, not the growing token union, so
      // the same story keeps the same identity between runs.
      sig: signature(c.members[0]),
      score: scoreCluster(c),
    }))
    .filter((s) => s.cluster.sources.size >= minSources)
    .sort((a, b) => b.score - a.score);

  const fresh = scored.filter((s) => !seenSignatures.has(s.sig));
  return { chosen: fresh[0] || null, ranked: scored };
}

/** Compact, token-efficient brief handed to the model. */
export function buildBrief(cluster, maxItems = 5) {
  const items = [...cluster.items].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, maxItems);
  const sources = [...cluster.sources].slice(0, 6);

  const lines = items.map((it, i) => {
    const summary = it.summary ? ` :: ${it.summary.slice(0, 320)}` : '';
    return `${i + 1}. [${it.source}] ${it.title}${summary}`;
  });

  return {
    text: lines.join('\n'),
    sources,
    primarySource: items[0]?.source || sources[0] || 'wire reports',
    headline: items[0]?.title || '',
    image: cluster.image || '',
    url: items[0]?.url || '',
  };
}
