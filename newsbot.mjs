#!/usr/bin/env node
// NewsBot — gather the day's news, write ten different X posts, bundle each with
// licence-cleared images into its own folder for manual review and upload.
//
// Zero npm dependencies. Node 18+ (developed on 24).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newsSearch, setThrottle } from './lib/ddg.mjs';
import { fetchAll } from './lib/feeds.mjs';
import { pickStory, clusterItems, scoreCluster, signature, buildBrief } from './lib/cluster.mjs';
import { scrapeArticle, mapLimit } from './lib/scrape.mjs';
import { resolveModels } from './lib/llm.mjs';
import { ANGLES, composePost, selectStories } from './lib/compose.mjs';
import { findImages, downloadImages } from './lib/images.mjs';
import { renderCard, findBrowser } from './lib/card.mjs';
import { writeBundle, writeIndex, runStamp, fullPostText } from './lib/bundle.mjs';
import { makeLogger, loadSeen, recordPost, recordRun, PROJECT_ROOT } from './lib/store.mjs';
import { classifyCluster, DOMAIN_LABELS } from './lib/domains.mjs';
import { createLimiter, batched } from './lib/ratelimit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* --------------------------------- setup --------------------------------- */

function loadEnv() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    process.env[m[1]] = value;
  }
}

function parseArgs(argv) {
  const args = { queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--posts': case '-n': args.posts = parseInt(next(), 10); break;
      case '--query': case '-q': args.queries.push(next()); break;
      case '--region': args.region = next(); break;
      case '--policy': args.policy = next(); break;
      case '--out': case '-o': args.out = next(); break;
      case '--browser': args.browser = next(); break;
      case '--timelimit': args.timelimit = next(); break;
      case '--no-images': args.noImages = true; break;
      case '--no-card': args.noCard = true; break;
      case '--no-scrape': args.noScrape = true; break;
      case '--fresh': args.fresh = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--check': args.check = true; break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

const HELP = `
NewsBot — ten ready-to-post news bundles per run

USAGE
  node newsbot.mjs [options]

OPTIONS
  -n, --posts <n>       How many posts to produce        (default: 10)
  -q, --query <text>    Override search topics; repeatable
      --region <code>   DDG region, e.g. us-en, in-en, uk-en
      --timelimit <d|w|m>  How far back to search        (default: d)
      --policy <safe|any>  Image licensing policy        (default: safe)
  -o, --out <dir>       Output directory                 (default: output)
      --browser <path>  Path to Edge/Chrome for card rendering
      --no-images       Skip stock image download
      --no-card         Skip generated text cards
      --no-scrape       Headlines only, don't fetch article bodies
      --fresh           Ignore the "already covered" history
      --dry-run         Gather and rank only; no AI calls, no files written
      --check           Verify setup and connectivity, then exit
  -v, --verbose         Show debug logging
  -h, --help            This message

EXAMPLES
  node newsbot.mjs
  node newsbot.mjs --posts 5 --region in-en
  node newsbot.mjs -q "artificial intelligence" -q "space launch" --policy any
  node newsbot.mjs --dry-run --verbose
`;

/* ------------------------------- pipeline ------------------------------- */

async function gather(cfg, args, log) {
  // CLI queries arrive as bare strings; config queries carry their domain.
  const queries = args.queries.length
    ? args.queries.map((q) => ({ domain: 'general', query: q }))
    : cfg.search.queries;
  const region = args.region || cfg.search.region;
  const timelimit = args.timelimit ?? cfg.search.timelimit;
  const failures = [];
  const items = [];

  log('info', `searching DuckDuckGo across ${queries.length} topic${queries.length === 1 ? '' : 's'}…`);

  // Sequential by design: ddg.mjs throttles globally, and hammering DDG in
  // parallel is the fastest route to a 403.
  for (const { domain, query } of queries) {
    try {
      const found = await newsSearch(query, {
        maxResults: cfg.search.resultsPerQuery,
        region,
        timelimit,
        safesearch: cfg.search.safesearch,
      });
      // Tag with the beat that found it — the strongest domain signal we have.
      items.push(...found.map((it) => ({ ...it, domain })));
      log('info', `  ${found.length.toString().padStart(3)} results  ·  ${domain.padEnd(13)} ${query}`);
    } catch (err) {
      failures.push(`DDG "${query}": ${err.message}`);
      log('warn', `  DDG failed for "${query}": ${err.message}`);
    }
  }

  // RSS is the safety net: if DDG throttles us, the run still produces posts.
  if (cfg.feeds.enabled) {
    log('info', `fetching ${cfg.feeds.list.length} RSS feeds as backup…`);
    const { items: feedItems, failed } = await fetchAll(cfg.feeds.list, {
      maxAgeHours: cfg.feeds.maxAgeHours,
      log,
    });
    items.push(...feedItems.map((i) => ({ ...i, origin: 'rss' })));
    log('info', `  ${feedItems.length} results from RSS`);
    failures.push(...failed.map((f) => `RSS ${f.feed}: ${f.error}`));
  }

  // Same story from two pipelines is common; collapse on URL.
  const byUrl = new Map();
  for (const it of items) {
    const key = (it.url || it.title).replace(/[?#].*$/, '');
    if (!byUrl.has(key)) byUrl.set(key, it);
  }
  return { items: [...byUrl.values()], failures };
}

async function enrich(story, cfg, args, log) {
  const brief = buildBrief(story.cluster);
  brief.sourceList = story.cluster.items.slice(0, 6).map((i) => ({
    source: i.source,
    title: i.title,
    url: i.url,
  }));

  if (args.noScrape || !cfg.scrape.enabled) return brief;

  const targets = story.cluster.items
    .filter((i) => i.url)
    .slice(0, cfg.scrape.articlesPerStory)
    .map((i) => i.url);

  const scraped = (
    await mapLimit(targets, cfg.scrape.concurrency, (url) =>
      scrapeArticle(url, { maxChars: cfg.scrape.maxCharsPerArticle, log })
    )
  ).filter((s) => s?.body && s.body.length > 250);

  if (scraped.length) {
    brief.body = scraped.map((s) => s.body).join('\n\n').slice(0, cfg.scrape.maxCharsPerArticle * 1.5);
    brief.scrapedCount = scraped.length;
    // The publisher's own og:image is the most on-topic photo available, but it
    // is almost always wire copy — recorded for reference, never auto-attached.
    brief.publisherImage = scraped.find((s) => s.image)?.image || '';
  }
  return brief;
}

async function buildImagery(post, brief, folder, cfg, args, log) {
  const images = [];
  let cardFile = null;

  if (cfg.images.generateCard && !args.noCard) {
    const ok = await renderCard(
      {
        headline: post.card.headline,
        kicker: `${post.card.kicker} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        source: brief.primarySource,
        stat: post.card.stat,
        theme: post.themeIndex,
      },
      join(folder, 'card.png'),
      { browserPath: args.browser || cfg.images.browserPath, log }
    );
    if (ok) cardFile = 'card.png';
  }

  if (!args.noImages && cfg.images.perPost > 0) {
    const candidates = await findImages(post.imageQueries, {
      policy: args.policy || cfg.images.policy,
      log,
    });
    if (candidates.length) {
      const saved = await downloadImages(candidates, {
        dir: folder,
        want: cfg.images.perPost,
        minBytes: cfg.images.minBytes,
        log,
      });
      images.push(...saved);
    }
  }
  return { images, cardFile };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);

  loadEnv();
  const log = makeLogger({ verbose: args.verbose });
  const started = Date.now();

  const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
  const wanted = args.posts || cfg.posts;
  setThrottle(cfg.search.throttleMs);

  const apiKey = process.env.OPENROUTER_API_KEY;

  /* --check ---------------------------------------------------------- */
  if (args.check) {
    console.log('\nNewsBot setup check\n');
    console.log(`  Node              ${process.version}`);
    console.log(`  OPENROUTER_API_KEY ${apiKey ? '✅ set (' + apiKey.slice(0, 15) + '…)' : '❌ MISSING — add it to newsbot/.env'}`);
    const browser = findBrowser(args.browser || cfg.images.browserPath);
    console.log(`  Card renderer     ${browser ? '✅ ' + browser : '⚠️  no Edge/Chrome found — cards disabled'}`);
    try {
      const r = await newsSearch('world news', { maxResults: 3, timelimit: 'd' });
      console.log(`  DuckDuckGo        ✅ reachable (${r.length} results)`);
    } catch (e) {
      console.log(`  DuckDuckGo        ❌ ${e.message}`);
    }
    if (apiKey) {
      try {
        const models = await resolveModels(cfg, log);
        console.log(`  Free models       ✅ ${models.length} available`);
        console.log(`                    top: ${models.slice(0, 4).join(', ')}`);
      } catch (e) {
        console.log(`  Free models       ❌ ${e.message}`);
      }
    }
    console.log('');
    return;
  }

  console.log(`\n📰 NewsBot — building ${wanted} post bundles\n`);

  /* 1. gather --------------------------------------------------------- */
  const { items, failures } = await gather(cfg, args, log);
  if (!items.length) {
    console.error('\n❌ No articles found. DuckDuckGo may be rate-limiting — wait a few minutes, or run with --verbose to see why.\n');
    process.exitCode = 1;
    return;
  }
  console.log(`\n  → ${items.length} articles from ${new Set(items.map((i) => i.source)).size} sources`);

  /* 2. cluster + rank -------------------------------------------------- */
  const seen = cfg.dedupe.enabled && !args.fresh ? loadSeen(cfg.dedupe.retentionDays) : { entries: [], signatures: new Set(), texts: [] };
  const { ranked } = pickStory(items, {
    seenSignatures: seen.signatures,
    minSources: cfg.cluster.minSources,
    blockedPatterns: cfg.cluster.blockedPatterns,
  });

  for (const r of ranked) r.domain = classifyCluster(r.cluster);

  const unseen = ranked.filter((r) => !seen.signatures.has(r.sig));
  const pool = unseen.length >= wanted ? unseen : ranked; // fall back rather than under-deliver
  const stories = selectStories(pool, wanted, {
    maxSubjectOverlap: cfg.diversity.maxSubjectOverlap,
    oneStoryPerDomain: cfg.diversity.oneStoryPerDomain,
  });

  const domainsHit = new Set(stories.map((s) => s.domain));
  console.log(`  → ${ranked.length} distinct stories, ${stories.length} selected across ${domainsHit.size} domains\n`);

  if (args.dryRun) {
    console.log('DRY RUN — stories that would become posts:\n');
    stories.forEach((s, i) => {
      const sources = [...s.cluster.sources].slice(0, 3).join(', ');
      const label = (DOMAIN_LABELS[s.domain] || s.domain).toUpperCase();
      console.log(`  ${String(i + 1).padStart(2)}. [${label}] ${s.cluster.items[0].title.slice(0, 86)}`);
      console.log(`      score ${s.score.toFixed(1)} · ${s.cluster.sources.size} outlet(s): ${sources}\n`);
    });
    return;
  }

  if (!apiKey) {
    console.error('\n❌ OPENROUTER_API_KEY is not set.\n   Create newsbot/.env with:  OPENROUTER_API_KEY=sk-or-v1-...\n   Get a free key at https://openrouter.ai/keys\n');
    process.exitCode = 1;
    return;
  }

  /* 3. resolve models -------------------------------------------------- */
  const models = await resolveModels(cfg, log);
  console.log(`  🤖 model chain: ${models.slice(0, 3).join(' → ')}${models.length > 3 ? ` → +${models.length - 3}` : ''}\n`);

  // OpenRouter caps free keys at 20 requests/minute. Staying just under that with
  // a shared limiter lets us generate posts concurrently without eating 429s.
  const limiter = createLimiter({ rpm: cfg.llm.rpm, concurrency: cfg.llm.concurrency, log });

  const llm = {
    apiKey,
    models,
    temperature: cfg.llm.temperature,
    maxTokens: cfg.llm.maxTokens,
    title: cfg.llm.appName,
    limiter,
  };

  /* 4. build each bundle ------------------------------------------------ */
  const outRoot = resolve(args.out || join(PROJECT_ROOT, cfg.output.dir));
  const runDir = join(outRoot, runStamp());
  mkdirSync(runDir, { recursive: true });

  const results = [];
  const usedModels = new Set();
  const avoid = [];

  // Batched rather than fully parallel: posts within a batch run concurrently
  // (bounded by the limiter), while `avoid` accumulates between batches so later
  // posts can be told what phrasing earlier ones already used.
  await batched(stories, cfg.llm.concurrency, async (story, i) => {
    const index = i + 1;
    const angle = ANGLES[i % ANGLES.length];
    const label = (DOMAIN_LABELS[story.domain] || story.domain).padEnd(9);
    const headline = story.cluster.items[0].title.slice(0, 58);

    try {
      const brief = await enrich(story, cfg, args, log);
      const post = await composePost({ brief, angle, index, avoid: avoid.slice(-4), llm, log });
      post.themeIndex = i;
      post.domain = story.domain;
      usedModels.add(post.model);

      const folder = writeBundle({ runDir, index, post, brief, images: [], cardFile: null });
      const { images, cardFile } = await buildImagery(post, brief, folder, cfg, args, log);
      // Rewrite now that we know what imagery actually landed.
      writeBundle({ runDir, index, post, brief, images, cardFile });

      results.push({ index, post, brief, images, cardFile, folder });
      avoid.push(post.hook.slice(0, 60));
      if (cfg.dedupe.enabled) recordPost(seen, { sig: story.sig, text: post.hook, url: brief.url });

      // Report the count of what actually gets pasted (hook + hashtags), matching
      // post.md and INDEX.md rather than the hook alone.
      const { count } = fullPostText(post);
      const flag = count > 280 ? '⚠️' : '✅';
      console.log(`  [${String(index).padStart(2)}/${stories.length}] ${label} ${angle.id.padEnd(15)} ${flag} ${String(count).padStart(3)}c · ${(cardFile ? 1 : 0) + images.length} img · ${headline}…`);
    } catch (err) {
      const msg = err.message.split('\n')[0];
      console.log(`  [${String(index).padStart(2)}/${stories.length}] ${label} ${angle.id.padEnd(15)} ❌ ${msg.slice(0, 60)}`);
      failures.push(`post ${index}: ${msg}`);
      log('error', `post ${index} failed: ${err.message}`);
    }
  });

  results.sort((a, b) => a.index - b.index);

  /* 5. index + summary --------------------------------------------------- */
  const durationSec = Math.round((Date.now() - started) / 1000);
  const stats = {
    gathered: items.length,
    clusters: ranked.length,
    scraped: results.filter((r) => r.brief.scrapedCount).length,
    sources: new Set(items.map((i) => i.source)).size,
    models: [...usedModels],
    durationSec,
    failures,
  };

  if (results.length) writeIndex({ runDir, results, stats });
  recordRun({ at: new Date().toISOString(), produced: results.length, wanted, durationSec, runDir });

  console.log(`\n${results.length === wanted ? '✅' : '⚠️ '} ${results.length}/${wanted} bundles written in ${durationSec}s`);
  console.log(`\n   📁 ${runDir}`);
  console.log(`   📄 Start with INDEX.md\n`);

  if (failures.length) {
    console.log(`   ${failures.length} warning(s) — see state/newsbot.log`);
    if (args.verbose) failures.forEach((f) => console.log(`     · ${f}`));
    console.log('');
  }
  if (!results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}\n`);
  if (process.argv.includes('--verbose')) console.error(err.stack);
  process.exitCode = 1;
});


