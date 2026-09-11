// Client for the "Ask AI about this user" chat (User Lookup profile). Sends a
// system instruction (the user's profile + all their transcripts) plus the
// running message history to the dev server's /api/chat proxy (Gemini via
// Vertex, shared with the tutor-eval client) and returns the assistant's reply.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function chatAboutUser(
  system: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages }),
  });
  if (!res.ok) {
    let msg = `Chat failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  const json = await res.json();
  return typeof json?.text === "string" ? json.text : "";
}
