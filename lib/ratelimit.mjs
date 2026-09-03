// Shared rate limiter for OpenRouter.
//
// OpenRouter enforces a hard 20 requests/minute cap across free models, and free
// keys are additionally capped per day. Exceeding the RPM gets 429s that burn the
// daily budget without producing anything, so every call funnels through here.
//
// Two independent controls:
//   - sliding-window RPM: never more than `rpm` starts in any rolling 60s
//   - semaphore: never more than `concurrency` in flight at once
import { setTimeout as sleep } from 'node:timers/promises';

export function createLimiter({ rpm = 18, concurrency = 3, log = () => {} } = {}) {
  const starts = [];          // timestamps of recent request starts
  let active = 0;
  const waiting = [];
  let dailyCount = 0;

  const prune = (now) => {
    while (starts.length && now - starts[0] >= 60_000) starts.shift();
  };

  function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
  }

  async function acquire() {
    if (active >= concurrency) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active++;

    // Hold the slot until the rolling window has room.
    for (;;) {
      const now = Date.now();
      prune(now);
      if (starts.length < rpm) {
        starts.push(now);
        dailyCount++;
        return;
      }
      const waitMs = 60_000 - (now - starts[0]) + 60;
      log('debug', `rate limit: ${starts.length}/${rpm} rpm used, pausing ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }

  /** Run `fn` under both limits. */
  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    get requestCount() {
      return dailyCount;
    },
    stats() {
      prune(Date.now());
      return { inFlight: active, windowUsed: starts.length, rpm, total: dailyCount };
    },
  };
}

/** Process items in bounded batches, preserving order. */
export async function batched(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const done = await Promise.all(slice.map((item, j) => fn(item, i + j)));
    out.push(...done);
  }
  return out;
}
