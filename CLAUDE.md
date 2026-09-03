# NewsBot — Project Guidelines for Claude Code

## Overview
Autonomous news aggregation and curation pipeline. Scrapes DuckDuckGo and RSS news feeds, performs Jaccard and overlap clustering to group distinct stories, scrapes full article text, applies 10 distinct rhetorical angles, downloads license-cleared imagery (CC0 / Public Domain), generates 1200x675 social cards via headless Edge/Chromium, and writes ready-to-post bundles.

Zero npm dependencies — relies purely on Node.js 18+ built-in modules (`fetch`, `fs/promises`, `crypto`, `child_process`).

## Commands
- **Run pipeline**: `node newsbot.mjs`
- **Verify setup**: `node newsbot.mjs --check`
- **Dry run**: `node newsbot.mjs --dry-run`
- **Curated hot topics**: `npm run hot`
- **Custom topic run**: `node newsbot.mjs -q "AI agents" -q "space tech"`
- **Fresh run (ignore seen)**: `node newsbot.mjs --fresh`

## Architecture
- `newsbot.mjs`: CLI orchestrator, argument parsing, execution stages.
- `lib/ddg.mjs`: DuckDuckGo internal endpoint querying, VQD token extraction and caching.
- `lib/feeds.mjs`: Parallel RSS fallback fetcher and XML parsing.
- `lib/cluster.mjs`: Jaccard & overlap coefficient clustering; headline deduplication and scoring.
- `lib/scrape.mjs`: HTML fetcher, `<p>` tag scoring, article body extraction.
- `lib/compose.mjs`: Rhetorical angle assignment (THE_NUMBER, THE_CONTRAST, THE_STAKES, etc.) and post generation.
- `lib/llm.mjs`: OpenRouter client with automatic free-model rotation, fallbacks, and schema validation.
- `lib/ratelimit.mjs`: Sliding-window RPM limiter + concurrency semaphore.
- `lib/images.mjs`: Openverse CC0 and Wikimedia Commons image scraper & license verifier.
- `lib/card.mjs`: Headless browser card renderer (1200x675 SVG/HTML to PNG).
- `lib/bundle.mjs`: Per-story directory bundling, CREDITS.md, and INDEX.md generator.
- `lib/store.mjs`: Persistent run tracking and seen story deduplication in `state/`.

## Code Conventions
- Pure ES Modules (`.mjs`).
- Zero external runtime npm dependencies.
- Defensive error handling: network timeouts, fallback endpoints, and rate-limit backoffs.
- Always preserve `.env` isolation; never log or commit secret tokens.
