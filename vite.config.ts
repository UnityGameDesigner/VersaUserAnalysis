import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Gemini-on-Vertex proxy for the tutor-evaluation feature (All Transcripts tab).
// Google's auth libraries can't run in a browser, so the dev server forwards
// evaluation requests to Vertex AI signed with the local gcloud
// application-default credentials (`gcloud auth application-default login`).
// Usage is billed to the GCP project — same setup as VersaConversationEngine.
function tutorEvalVertexProxy(
  projectId: string,
  model: string,
  location: string,
  keyFile?: string,
): Plugin {
  let clientPromise: Promise<import('@google/genai').GoogleGenAI> | null = null
  const getClient = () => {
    clientPromise ??= import('@google/genai').then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          vertexai: true,
          project: projectId,
          location,
          // Point GOOGLE_APPLICATION_CREDENTIALS at a service-account key file to
          // authenticate without the periodic `gcloud auth application-default
          // login` reauth that user credentials (ADC type "authorized_user")
          // require. Falls back to gcloud ADC when the var is unset.
          ...(keyFile ? { googleAuthOptions: { keyFilename: keyFile } } : {}),
        }),
    )
    return clientPromise
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    res.setHeader('Content-Type', 'application/json')
    try {
      const { system, prompt, schema } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const ai = await getClient()
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      })
      res.end(JSON.stringify({ text: response.text ?? null }))
    } catch (e) {
      clientPromise = null // a failed client (e.g. expired ADC) shouldn't be reused
      const status = (e as { status?: number }).status
      res.statusCode = typeof status === 'number' ? status : 500
      let msg = e instanceof Error ? e.message : String(e)
      if (/credential|oauth|invalid_grant|unauthenticated/i.test(msg)) {
        msg += ' — run `gcloud auth application-default login`, then retry.'
      }
      res.end(JSON.stringify({ error: msg }))
    }
  }

  // Batch translation via the same Gemini client. Reliable (no per-IP quota like
  // the public gtx endpoint), one request for a whole conversation, and it keeps
  // input order/length. POST { texts: string[] } -> { translations: string[] }.
  const translateHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    res.setHeader('Content-Type', 'application/json')
    try {
      const { texts } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Array.isArray(texts) || texts.length === 0) {
        res.end(JSON.stringify({ translations: [] }))
        return
      }
      const ai = await getClient()
      const response = await ai.models.generateContent({
        model,
        contents:
          'Translate each string in this JSON array to natural English. Return ONLY a ' +
          'JSON array of strings of the SAME length and order. If a string is already ' +
          'English, return it unchanged.\n\n' +
          JSON.stringify(texts),
        config: {
          systemInstruction:
            'You are a translation engine. Output only a JSON array of translated ' +
            'strings, exactly the same length and order as the input array.',
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'array', items: { type: 'string' } },
        },
      })
      const translations = JSON.parse(response.text ?? '[]')
      res.end(JSON.stringify({ translations }))
    } catch (e) {
      clientPromise = null
      const status = (e as { status?: number }).status
      res.statusCode = typeof status === 'number' ? status : 500
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }

  // Free-form chat over a user's transcripts (the "Ask AI about this user" panel
  // on the User Lookup profile). The client sends a system instruction (profile +
  // all transcripts) and the running message history; we relay to Gemini and
  // return plain text. POST { system, messages:[{role,content}] } -> { text }.
  const chatHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    res.setHeader('Content-Type', 'application/json')
    try {
      const { system, messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const contents = (Array.isArray(messages) ? messages : []).map(
        (m: { role?: string; content?: string }) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(m.content ?? '') }],
        }),
      )
      const ai = await getClient()
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction: String(system ?? '') },
      })
      res.end(JSON.stringify({ text: response.text ?? '' }))
    } catch (e) {
      clientPromise = null
      const status = (e as { status?: number }).status
      res.statusCode = typeof status === 'number' ? status : 500
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return {
    name: 'tutor-eval-vertex-proxy',
    configureServer(server) {
      server.middlewares.use('/api/evaluate-tutor', handler)
      server.middlewares.use('/api/translate-batch', translateHandler)
      server.middlewares.use('/api/chat', chatHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/evaluate-tutor', handler)
      server.middlewares.use('/api/translate-batch', translateHandler)
      server.middlewares.use('/api/chat', chatHandler)
    },
  }
}

// Translation proxy. The browser can't call Google's gtx translate endpoint
// directly — it sends no CORS headers, so the fetch fails with "TypeError:
// Failed to fetch". Forward it through the dev/preview server (server-to-server
// has no CORS) and return the upstream JSON verbatim so the client parses it
// exactly as before. POST { text } -> the raw gtx array (or { error }).
function translateProxy(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    res.setHeader('Content-Type', 'application/json')
    try {
      const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!text || !String(text).trim()) {
        res.end(JSON.stringify([[]]))
        return
      }
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' +
        encodeURIComponent(String(text))
      const upstream = await fetch(url)
      if (!upstream.ok) {
        res.statusCode = upstream.status
        res.end(JSON.stringify({ error: `upstream ${upstream.status}` }))
        return
      }
      res.end(await upstream.text())
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }
  return {
    name: 'translate-proxy',
    configureServer(server) {
      server.middlewares.use('/api/translate', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/translate', handler)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      translateProxy(),
      tutorEvalVertexProxy(
        env.GCP_PROJECT_ID || 'versa-443600',
        env.GEMINI_EVAL_MODEL || 'gemini-2.5-flash',
        // The `global` endpoint has no gemini-2.5-flash quota on this project and
        // returns a permanent 429 RESOURCE_EXHAUSTED; the regional endpoints do.
        env.VERTEX_LOCATION || 'us-central1',
        env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
      ),
    ],
  }
})
