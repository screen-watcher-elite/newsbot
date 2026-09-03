# NewsBot — User Guide & Architecture Reference

NewsBot is a standalone CLI tool that gathers, clusters, scrapes, synthesizes, and bundles the day’s top news into ready-to-post social media packages.

---

## Quickstart

### Prerequisites
- Node.js 18.17+ installed.
- Zero npm dependencies — no `npm install` necessary.

### Setup
1. Get a free API key at [OpenRouter](https://openrouter.ai/keys).
2. Create a `.env` file in the project root:
   ```env
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   ```
3. Run verification check:
   ```bash
   node newsbot.mjs --check
   ```

---

## CLI Flags & Options

| Command / Flag | Description |
| :--- | :--- |
| `node newsbot.mjs` | Standard execution (runs full pipeline, produces 10 bundles). |
| `node newsbot.mjs --posts 3` | Produce a custom number of bundles (e.g. 3 or 5). |
| `node newsbot.mjs --dry-run` | Shows story picks, clusters, and rankings without making AI calls or saving files. |
| `node newsbot.mjs --check` | Validates Node version, API connectivity, Edge renderer, and model availability. |
| `node newsbot.mjs --region in-en` | Sets regional bias (e.g., `in-en`, `uk-en`, `us-en`, `wt-wt`). |
| `node newsbot.mjs --timelimit w` | Broadens search window to the past week instead of past 24 hours (`d`). |
| `node newsbot.mjs --fresh` | Ignores previously seen story deduplication history in `state/seen.json`. |
| `node newsbot.mjs --no-images` | Skips photo downloads, renders only generated cards. |
| `node newsbot.mjs --verbose` | Outputs full debug logs to the terminal. |

---

## Output Bundle Structure

Every successful run creates a timestamped folder inside `output/`:

```
output/2026-09-03_1618/
├── INDEX.md                        # Master overview of all generated posts
├── 01-ai-robotaxis-launch/
│   ├── post.md                     # Ready-to-copy post text, alt text, and source links
│   ├── card.png                    # Generated 1200x675 high-res social card
│   ├── image-1.jpg                 # Public-domain / CC0 stock photo
│   ├── CREDITS.md                  # Strict licensing audit for all included media
│   └── meta.json                   # Machine-readable metadata & sources
├── 02-energy-grid-breakthrough/
└── ...
```

---

## The 10 Rhetorical Angles

NewsBot rotates across 10 distinct rhetorical angles to avoid repetitive copy:

1. `THE_NUMBER`: Anchors the story around an eye-opening metric.
2. `THE_CONTRAST`: Juxtaposes conflicting trends or opposing viewpoints.
3. `THE_CONSEQUENCE`: Focuses on second-order downstream effects.
4. `THE_SCENE`: Narrative-driven opening that places the reader on the ground.
5. `THE_STAKES`: Highlights who wins, who loses, and what's at risk.
6. `THE_REVERSAL`: Focuses on an unexpected pivot or sudden shift.
7. `THE_EXPLAINER`: Deconstructs a complex mechanism into plain language.
8. `THE_HUMAN`: Focuses on personal impact and individual lives.
9. `THE_QUOTE`: Anchors the story around a pivotal statement.
10. `THE_PATTERN`: Connects the isolated event to a broader global macro trend.

---

## Safe Image Licensing Policy

NewsBot implements an aggressive anti-DMCA policy to protect your publishing accounts:

- **Tier A (`card.png`)**: Generated locally by NewsBot via headless Chromium/Edge. 100% owned by you. Zero attribution required.
- **Tier B (Openverse CC0 / Public Domain)**: Safe to publish without attribution.
- **Tier C (Wikimedia CC-BY)**: Requires attribution line included in `CREDITS.md`.
- **Tier D (General Web)**: Disabled by default (`images.policy: safe`).

Always check `CREDITS.md` inside each post directory before publishing.
