# Claude Code Project Memory

- **Project**: NewsBot Autonomous Pipeline
- **Core Principle**: Zero external dependencies. All networking, parsing, rendering, and concurrency use Node.js standard libraries.
- **Image Licensing**: Strict compliance. Tier A (generated card) and Tier B (CC0/Public Domain) are safe to publish. Tier D is disabled by default to protect user social accounts from DMCA issues.
- **Model Fallbacks**: Free model IDs on OpenRouter cycle frequently; the pipeline queries `/api/v1/models` dynamically to select active $0 models, with fallback to `openrouter/free`.
