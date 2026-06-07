// Translate arbitrary-language text to English. Uses Google's public gtx
// endpoint because it auto-detects the source language (sl=auto) — MyMemory
// has no auto-detect and 403s without an explicit source language, which is a
// non-starter for transcripts that can be in any language.
export async function translateText(text: string): Promise<string> {
  if (!text.trim()) return text;
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(
      text,
    )}`,
  );
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
