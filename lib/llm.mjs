// OpenRouter client. Free model IDs rotate constantly, so we never hardcode one:
// we read the live catalog, keep only genuinely $0 models, and walk a fallback chain.
import { request, getJSON } from './http.mjs';
import { readJSON, writeJSON } from './store.mjs';

const API = 'https://openrouter.ai/api/v1';
const CACHE_TTL_MS = 12 * 3600_000;

// Distinguishes an account-wide quota wall from a single model being busy.
// Upstream messages read "temporarily rate-limited upstream"; account ones name
// the key's own daily allowance.
const ACCOUNT_LIMIT = /free-models-per-day|daily limit|per-day quota|add (?:more )?credits|insufficient credits/i;

// Preference order when these happen to be free. Anything unlisted still gets used,
// just ranked after these. Good instruction-following + decent prose is what matters here.
const PREFERRED = [
  'moonshotai/kimi',
  'deepseek/deepseek-chat',
  'z-ai/glm',
  'qwen/qwen3',
  'meta-llama/llama-3.3',
  'google/gemma',
  'mistralai/mistral',
  'nvidia/nemotron',
  'openai/gpt-oss',
];

function isFree(model) {
  const p = model?.pricing || {};
  const zero = (v) => v === undefined || v === null || Number(v) === 0;
  const id = String(model.id || '');
  return zero(p.prompt) && zero(p.completion) && id.endsWith(':free') && !id.includes('nemotron');
}

function rank(id) {
  const i = PREFERRED.findIndex((p) => id.startsWith(p));
  return i === -1 ? PREFERRED.length : i;
}

/** Discover currently-free models, cached to disk so we hit the catalog at most twice a day. */
export async function resolveModels(cfg, log = () => {}) {
  if (Array.isArray(cfg.llm.models) && cfg.llm.models.length && cfg.llm.pinModels) {
    return cfg.llm.models;
  }

  const cached = readJSON('models.json', null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.ids?.length) {
    return dedupe([...(cfg.llm.models || []), ...cached.ids, 'openrouter/free']);
  }

  let discovered = [];
  try {
    const data = await getJSON(`${API}/models`, { timeoutMs: 20000, retries: 1 });
    discovered = (data?.data || [])
      .filter(isFree)
      .sort((a, b) => rank(a.id) - rank(b.id) || (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id);
    writeJSON('models.json', { fetchedAt: Date.now(), ids: discovered });
    log('info', `discovered ${discovered.length} free models; top: ${discovered.slice(0, 3).join(', ') || 'none'}`);
  } catch (err) {
    log('warn', `model discovery failed, using configured fallbacks: ${err.message}`);
    discovered = cached?.ids || [];
  }

  // 'openrouter/free' is OpenRouter's auto-router across free models: the last resort
  // that keeps working even when every specific ID we know has been retired.
  return dedupe([...(cfg.llm.models || []), ...discovered, 'openrouter/free']);
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/** Lenient JSON extraction — free models love wrapping JSON in prose or code fences. */
export function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];

  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    const slice = c.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // Trailing commas are the most common malformation; try one repair pass.
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch { /* fall through to next candidate */ }
    }
  }
  return null;
}

/**
 * Chat completion with a model fallback chain.
 * Returns { text, model }. Throws only if every model fails.
 */
export async function chat({ apiKey, models, messages, maxTokens = 700, temperature = 0.85, referer, title, limiter, log = () => {} }) {
  const errors = [];
  // Every OpenRouter call passes through the shared limiter so the 20 RPM cap
  // holds no matter how many posts are being generated in parallel.
  const gate = limiter ? (fn) => limiter.run(fn) : (fn) => fn();

  for (const model of models) {
    try {
      const res = await gate(() => request(`${API}/chat/completions`, {
        method: 'POST',
        timeoutMs: 90000,
        retries: 1,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': referer || 'https://localhost/newsbot',
          'x-title': title || 'NewsBot',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          top_p: 0.95,
        }),
      }));

      const body = await res.text();
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status} ${body.slice(0, 160)}`);
        log('warn', `model ${model} -> HTTP ${res.status}`);

        // Two very different 429s share a status code:
        //   upstream  - THIS model is busy; the next model in the chain will work
        //   account   - the KEY is out of daily quota; every model will fail, so
        //               stop immediately instead of burning the chain on retries
        if (res.status === 429 && ACCOUNT_LIMIT.test(body)) {
          const e = new Error(
            'OpenRouter daily free-tier quota exhausted for this key. ' +
            'Wait for the daily reset, or add $10 of credit to raise the free allowance.'
          );
          e.fatal = true;
          throw e;
        }
        continue;
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        errors.push(`${model}: non-JSON response`);
        continue;
      }

      // OpenRouter reports upstream provider failures inside a 200 response.
      if (data.error) {
        errors.push(`${model}: ${data.error.message || 'provider error'}`);
        log('warn', `model ${model} -> ${data.error.message}`);
        continue;
      }

      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        errors.push(`${model}: empty completion`);
        continue;
      }

      log('info', `completion from ${model} (${text.length} chars)`);
      return { text, model };
    } catch (err) {
      if (err.fatal) throw err; // account-level wall: no point trying more models
      errors.push(`${model}: ${err.message}`);
      log('warn', `model ${model} threw: ${err.message}`);
    }
  }

  throw new Error(`all models failed:\n  ${errors.join('\n  ')}`);
}
