// Translate arbitrary-language text to English. Uses Google's public gtx
// endpoint because it auto-detects the source language (sl=auto) — MyMemory
// has no auto-detect and 403s without an explicit source language, which is a
// non-starter for transcripts that can be in any language.
export async function translateText(text: string): Promise<string> {
  if (!text.trim()) return text;
  // Abort a hung request so a stalled translation can't block a caller (e.g. the
  // Feedback tab's worker pool) indefinitely — let it fail fast and retry.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(
        text,
      )}`,
      { signal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const json = await res.json();
  // Shape: [[[translatedSegment, originalSegment, ...], ...], ..., detectedLang]
  const segments = json?.[0];
  if (!Array.isArray(segments)) return text;
  const translated = segments
    .map((seg: unknown) => (Array.isArray(seg) ? seg[0] : ""))
    .join("");
  return translated || text;
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
