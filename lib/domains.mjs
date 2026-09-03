// Domain classification, so a batch of ten covers ten different beats instead of
// five variations on whatever sport happened to be loud that day.
//
// Search results carry the domain of the query that found them. RSS items don't,
// so they get keyword-scored. Cluster domain is a weighted vote of its members.

export const DOMAINS = [
  'world', 'politics', 'business', 'technology', 'science',
  'health', 'climate', 'sports', 'entertainment', 'india',
];

export const DOMAIN_LABELS = {
  world: 'World', politics: 'Politics', business: 'Business', technology: 'Tech',
  science: 'Science', health: 'Health', climate: 'Climate', sports: 'Sports',
  entertainment: 'Culture', india: 'India', general: 'News',
};

// Weighted signals. Longer, more specific terms are worth more than generic ones.
const SIGNALS = {
  sports: [
    ['world series', 4], ['little league', 4], ['world cup', 3], ['grand slam', 3],
    ['premier league', 3], ['nba', 3], ['nfl', 3], ['test match', 3],
    ['olympic', 3], ['championship', 2], ['tournament', 2], ['striker', 2], ['midfielder', 2],
    ['innings', 3], ['wicket', 3], ['touchdown', 3], ['playoff', 2], ['fixture', 2],
    ['coach', 1], ['match', 1], ['goal', 1], ['league', 1], ['score', 1], ['team', 1],
    ['cricket', 3], ['football', 2], ['soccer', 3], ['tennis', 3], ['hockey', 3], ['athlete', 2],
  ],
  business: [
    ['stock market', 3], ['earnings', 3], ['nasdaq', 3], ['ipo', 3], ['central bank', 3],
    ['interest rate', 3], ['inflation', 3], ['merger', 3], ['acquisition', 2], ['revenue', 2],
    ['shares', 2], ['investor', 2], ['economy', 2], ['tariff', 2], ['trade deal', 2],
    ['profit', 2], ['layoff', 2], ['startup', 2], ['funding round', 3], ['billion', 1],
  ],
  technology: [
    ['artificial intelligence', 3], ['chatgpt', 3], ['openai', 3], ['semiconductor', 3],
    ['smartphone', 2], ['software', 2], ['cybersecurity', 3], ['data breach', 3],
    ['algorithm', 2], ['chipmaker', 3], ['app', 1], ['tech', 1], ['ai model', 3],
    ['robot', 2], ['quantum', 3], ['cloud computing', 3],
  ],
  science: [
    ['researchers', 2], ['study found', 3], ['nasa', 3], ['spacecraft', 3], ['telescope', 3],
    ['orbit', 2], ['species', 2], ['fossil', 3], ['physics', 3], ['genome', 3],
    ['experiment', 2], ['scientists', 2], ['astronomers', 3], ['launch', 1], ['discovery', 2],
  ],
  health: [
    ['outbreak', 3], ['vaccine', 3], ['clinical trial', 3], ['fda', 3], ['who', 1],
    ['patients', 2], ['disease', 2], ['hospital', 2], ['virus', 2], ['cancer', 3],
    ['drug', 2], ['mental health', 3], ['infection', 2], ['symptoms', 2], ['doctors', 2],
  ],
  climate: [
    ['climate change', 3], ['emissions', 3], ['heatwave', 3], ['wildfire', 3], ['hurricane', 3],
    ['flooding', 2], ['drought', 3], ['glacier', 3], ['renewable', 3], ['solar power', 3],
    ['carbon', 2], ['typhoon', 3], ['cyclone', 3], ['deforestation', 3], ['tropical storm', 3],
    ['monsoon', 2], ['environment', 2],
  ],
  politics: [
    ['parliament', 3], ['congress', 2], ['senate', 3], ['election', 3], ['president', 2],
    ['prime minister', 3], ['minister', 2], ['legislation', 3], ['sanctions', 2], ['diplomat', 2],
    ['vote', 2], ['campaign', 2], ['policy', 1], ['governor', 2], ['coalition', 2], ['summit', 2],
  ],
  world: [
    ['ceasefire', 3], ['airstrike', 3], ['refugee', 3], ['united nations', 3], ['border', 2],
    ['military', 2], ['troops', 2], ['conflict', 2], ['peace talks', 3], ['embassy', 2],
    ['killed', 1], ['attack', 1], ['war', 2], ['invasion', 3], ['drone', 2],
  ],
  entertainment: [
    ['box office', 3], ['film', 2], ['movie', 2], ['album', 3], ['netflix', 3],
    ['celebrity', 2], ['actor', 2], ['singer', 2], ['festival', 2], ['streaming', 2],
    ['bollywood', 3], ['hollywood', 3], ['series', 1], ['award', 2],
  ],
  india: [
    ['india', 2], ['delhi', 3], ['mumbai', 3], ['modi', 3], ['bengaluru', 3],
    ['rupee', 3], ['lok sabha', 3], ['kolkata', 3], ['chennai', 3], ['hyderabad', 3],
  ],
};

/** Score one text against every domain; returns [domain, score] best-first. */
export function scoreDomains(text) {
  const hay = ` ${String(text).toLowerCase()} `;
  const scores = new Map();

  for (const [domain, signals] of Object.entries(SIGNALS)) {
    let total = 0;
    for (const [term, weight] of signals) {
      if (hay.includes(` ${term}`) || hay.includes(`${term} `)) total += weight;
    }
    if (total > 0) scores.set(domain, total);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

export function classify(text, fallback = 'general') {
  const ranked = scoreDomains(text);
  return ranked.length && ranked[0][1] >= 2 ? ranked[0][0] : fallback;
}

/**
 * Domain of a cluster: the query-tagged domains of its members carry the most
 * weight (they came from a deliberate topical search), with keyword scoring
 * filling in for RSS items that arrived untagged.
 */
export function classifyCluster(cluster) {
  const votes = new Map();
  const add = (d, w) => {
    if (d && d !== 'general') votes.set(d, (votes.get(d) || 0) + w);
  };

  for (const item of cluster.items) {
    // The query that found an item is a decent hint, but a broad query like
    // "top world news" happily returns sports. So keyword evidence is weighted by
    // how strong it is, letting an unambiguous headline outvote the query tag.
    add(item.domain, 3);

    const ranked = scoreDomains(`${item.title} ${item.summary || ''}`);
    if (ranked.length && ranked[0][1] >= 2) {
      add(ranked[0][0], Math.min(5, ranked[0][1] / 2));
    }
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : 'general';
}
