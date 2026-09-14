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
    const timeout = setTimeout(() => controller.abort(), 8000);
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
    // Retry rate-limits only briefly — conversation translation has a Gemini
    // fallback, so fail over fast rather than backing off for many seconds.
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
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

// Translate a sequence of lines (e.g. conversation turns) using as FEW gtx
// requests as possible. Firing one request per line trips gtx's per-IP rate
// limit on long transcripts, so we batch lines into chunks, translate each chunk
// as a single newline-joined request, and split the result back by line. If a
// chunk's translation doesn't split into the expected number of lines (gtx
// occasionally merges/splits lines), that chunk falls back to per-line
// translation so the mapping stays correct. Preserves order; empty lines pass
// through untranslated. A 35-turn transcript goes from ~35 requests to ~3.
export async function translateLines(texts: string[]): Promise<string[]> {
  const MAX_LINES = 15; // lines per request
  const MAX_CHARS = 2500; // keep the encoded gtx URL well under length limits

  const chunks: number[][] = [];
  let cur: number[] = [];
  let curChars = 0;
  texts.forEach((t, i) => {
    const len = t.length + 1;
    if (cur.length > 0 && (cur.length >= MAX_LINES || curChars + len > MAX_CHARS)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(i);
    curChars += len;
  });
  if (cur.length) chunks.push(cur);

  const out = new Array<string>(texts.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const ci = next++;
      if (ci >= chunks.length) return;
      const idxs = chunks[ci];
      // One physical line per message (collapse any internal newlines) so the
      // response can be split back reliably.
      const lines = idxs.map((i) => texts[i].replace(/\s*\n\s*/g, " ").trim());
      if (lines.every((l) => !l)) {
        idxs.forEach((i) => (out[i] = texts[i]));
        continue;
      }
      let mapped = false;
      try {
        const parts = (await translateCached(lines.join("\n"))).split("\n");
        if (parts.length === idxs.length) {
          idxs.forEach((i, k) => (out[i] = texts[i].trim() ? parts[k] : texts[i]));
          mapped = true;
        }
      } catch {
        // fall through to per-line below
      }
      if (!mapped) {
        const perLine = await translateMany(
          idxs.map((i) => texts[i]),
          3,
        );
        idxs.forEach((i, k) => (out[i] = perLine[k]));
      }
    }
  }
  // Run chunks in parallel (most conversations are only a few chunks) so the whole
  // transcript translates in roughly one round-trip.
  await Promise.all(Array.from({ length: Math.min(6, chunks.length || 1) }, worker));
  return out;
}

// Translate a whole conversation FAST: split it into small chunks and translate
// them in parallel via Gemini flash-lite (/api/translate-batch). A 35-turn
// transcript finishes in ~1.5s instead of ~6s for one big sequential call. Falls
// back to the batched gtx path only if the Gemini path fails outright. Preserves
// order/length; empty inputs pass through.
const TRANSLATE_CHUNK = 8; // messages per Gemini request
const TRANSLATE_CONCURRENCY = 8; // max parallel requests (bounds very long transcripts)

export async function translateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += TRANSLATE_CHUNK) {
    chunks.push(texts.slice(i, i + TRANSLATE_CHUNK));
  }
  try {
    const results = new Array<string[]>(chunks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        results[i] = await geminiChunk(chunks[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, chunks.length) }, worker),
    );
    return results.flat();
  } catch {
    return translateLines(texts); // last-ditch (only helps if gtx isn't rate-limited)
  }
}

// One Gemini chunk, with a single retry for a transient hiccup so one bad chunk
// doesn't sink the whole conversation.
async function geminiChunk(texts: string[]): Promise<string[]> {
  try {
    return await geminiBatch(texts);
  } catch {
    return await geminiBatch(texts);
  }
}

// Gemini call that translates one array. Throws on failure so the caller can
// surface an error instead of silently showing the original.
async function geminiBatch(texts: string[]): Promise<string[]> {
  const res = await fetch("/api/translate-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const json = await res.json();
  if (json && typeof json === "object" && "error" in json) {
    throw new Error(`Translation failed: ${(json as { error: string }).error}`);
  }
  const t = json?.translations;
  if (Array.isArray(t) && t.length === texts.length) {
    return texts.map((orig, i) => (typeof t[i] === "string" && t[i].trim() ? t[i] : orig));
  }
  throw new Error("Translation failed");
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
