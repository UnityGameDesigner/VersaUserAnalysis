// Translate arbitrary-language text to English via the dev server's
// /api/translate proxy (vite.config.ts), which forwards to Google's public gtx
// endpoint server-side. gtx is used because it auto-detects the source language
// (sl=auto) — MyMemory has no auto-detect and 403s without one, a non-starter
// for transcripts in any language. The proxy is required because the browser
// can't call gtx directly: it sends no CORS headers, so a direct fetch fails
// with "TypeError: Failed to fetch". The proxy returns the raw gtx JSON verbatim.
export async function translateText(text: string): Promise<string> {
  if (!text.trim()) return text;
  // Abort a hung request so a stalled translation can't block a caller (e.g. the
  // Feedback tab's worker pool) indefinitely — let it fail fast and retry.
  // gtx rate-limits bursts (HTTP 429). Retry a few times with exponential
  // backoff before giving up — pairs with translateMany's concurrency cap.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300));
      continue;
    }
    if (!res.ok) throw new Error(`Translation failed (${res.status})`);
    const json = await res.json();
    if (json && typeof json === "object" && !Array.isArray(json) && "error" in json) {
      throw new Error(`Translation failed: ${(json as { error: string }).error}`);
    }
    // Shape: [[[translatedSegment, originalSegment, ...], ...], ..., detectedLang]
    const segments = json?.[0];
    if (!Array.isArray(segments)) return text;
    return (
      segments.map((seg: unknown) => (Array.isArray(seg) ? seg[0] : "")).join("") || text
    );
  }
}

// Translate many strings while capping concurrency, so a long transcript doesn't
// fire dozens of simultaneous requests and trip gtx's 429 rate limit. Preserves
// input order; empty strings pass through untranslated; uses translateCached so
// identical lines (and re-runs) hit the network at most once.
export async function translateMany(texts: string[], concurrency = 5): Promise<string[]> {
  const results = new Array<string>(texts.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= texts.length) return;
      const t = texts[i];
      results[i] = t.trim() ? await translateCached(t) : t;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, texts.length || 1) }, worker),
  );
  return results;
}

// Module-level translation cache, keyed by the trimmed source text. Persists for
// the life of the page so identical strings (e.g. the same one-word feedback
// left by many users) translate once, and so re-mounting a tab doesn't re-hit
// the network. `inflight` collapses concurrent requests for the same text into a
// single fetch.
const translationCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

// Synchronously read an already-resolved translation, or undefined if not cached
// yet. Lets a component seed its state from prior work without awaiting.
export function getCachedTranslation(text: string): string | undefined {
  return translationCache.get(text.trim());
}

// Translate with caching + in-flight de-duplication. Returns the English text
// (or the original on an empty/whitespace input). On network failure the result
// is NOT cached, so a later call can retry.
export async function translateCached(text: string): Promise<string> {
  const key = text.trim();
  if (!key) return text;
  const hit = translationCache.get(key);
  if (hit !== undefined) return hit;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = translateText(key)
    .then((res) => {
      translationCache.set(key, res);
      inflight.delete(key);
      return res;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p);
  return p;
}
