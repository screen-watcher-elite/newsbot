# Customizing NewsBot for Custom Domains & Beats

NewsBot is designed to prevent news homogenization. By default, it spans 10 general domains (World, Tech, Politics, Business, Science, Health, Climate, Sports, Culture, India). 

You can easily repurpose NewsBot to dominate specific niches—such as **Artificial Intelligence & Agents**, **Fintech & Crypto**, **Aerospace**, **Longevity Science**, or **Regional Local News**.

---

## 1. Quick CLI Overrides (Zero Config)

You can target specific beats on the fly using the `-q` (query) flag and `--region` without modifying any code:

### Example: AI & Frontier Tech Focus
```bash
node newsbot.mjs -q "autonomous AI agents" -q "frontier LLMs Anthropic OpenAI" -q "robotics spatial computing" -q "open source AI models"
```

### Example: Crypto & Web3 Focus
```bash
node newsbot.mjs -q "bitcoin crypto market" -q "ethereum L2 ecosystem" -q "stablecoins digital assets regulation" -q "defi protocol innovation"
```

### Example: Local / Regional Focus
Use the `--region` flag (`in-en` for India, `uk-en` for UK, `wt-wt` for Worldwide, `us-en` for US):
```bash
node newsbot.mjs --region in-en -q "Navi Mumbai tech infrastructure" -q "Maharashtra startup ecosystem"
```

---

## 2. Adding Custom Presets in `package.json`

Add reusable npm scripts to `package.json` for one-command niche runs:

```json
"scripts": {
  "start": "node newsbot.mjs",
  "ai": "node newsbot.mjs --region wt-wt -q \"frontier AI agents\" -q \"deep learning research\" -q \"semiconductor hardware\"",
  "crypto": "node newsbot.mjs --region wt-wt -q \"bitcoin institutional adoption\" -q \"crypto regulation SEC\" -q \"web3 decentralized protocols\"",
  "india": "node newsbot.mjs --region in-en -q \"India tech startup investments\" -q \"digital public infrastructure India\"",
  "hot": "node newsbot.mjs --region wt-wt -q \"global AI agents automation\" -q \"international gadgets spatial tech wearable robotics\" -q \"global space exploration aerospace\" -q \"global fintech crypto digital assets economy\" -q \"international biohacking longevity health science\""
}
```

Now you can simply run:
```bash
npm run ai
```

---

## 3. Permanent Topic Customization in `config.json`

For permanent changes, customize the `search.queries` array in [`config.json`](../config.json):

```json
"search": {
  "region": "wt-wt",
  "timelimit": "d",
  "safesearch": 1,
  "throttleMs": 1200,
  "resultsPerQuery": 25,
  "queries": [
    { "domain": "ai_agents",  "query": "AI agents autonomous workflows" },
    { "domain": "robotics",   "query": "humanoid robotics industrial automation" },
    { "domain": "biotech",    "query": "CRISPR gene therapy longevity science" },
    { "domain": "fintech",    "query": "fintech payment networks digital banking" }
  ]
}
```

---

## 4. Customizing RSS Feeds

DuckDuckGo news search is backed by parallel RSS feeds in case of search throttling. You can add niche RSS feeds in `config.json` under `feeds.list`:

```json
"feeds": {
  "enabled": true,
  "maxAgeHours": 24,
  "list": [
    { "name": "Ars Technica",  "url": "https://feeds.arstechnica.com/arstechnica/index" },
    { "name": "TechCrunch",    "url": "https://techcrunch.com/feed/" },
    { "name": "The Verge",     "url": "https://www.theverge.com/rss/index.xml" },
    { "name": "MIT Tech Review", "url": "https://www.technologyreview.com/feed/" }
  ]
}
```

---

## 5. Domain Scoring Engine (`lib/domains.mjs`)

When RSS feeds are fetched, articles don't carry a domain tag. NewsBot's internal scoring engine (`lib/domains.mjs`) analyzes headlines against weighted keyword signals.

To register a completely new domain label:
1. Add the domain identifier to `DOMAINS` in `lib/domains.mjs`.
2. Add a display label to `DOMAIN_LABELS`.
3. Add high-signal keyword tuples to `SIGNALS`:

```javascript
export const DOMAINS = ['world', 'ai', 'robotics', ...];

export const DOMAIN_LABELS = {
  ai: 'AI & Agents',
  robotics: 'Robotics',
  ...
};

const SIGNALS = {
  ai: [
    ['agentic', 4], ['anthropic', 4], ['claude', 4], ['neural network', 3],
    ['transformer', 3], ['llm', 3], ['reasoning model', 3], ['mcp', 3]
  ],
  ...
};
```
