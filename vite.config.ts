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
  translateModel?: string,
  claudeModel?: string,
  claudeLocation?: string,
): Plugin {
  // Translation is a simple task — use a faster/cheaper model than the eval model
  // when configured, else fall back to the eval model.
  const tModel = translateModel || model
  // Second judge for the cross-family eval panel: Claude on Vertex Model Garden
  // (same GCP project / credentials as Gemini). Needs the model enabled AND online-
  // prediction quota for it in the project, or calls come back 429 and the panel
  // just drops this judge.
  const cModel = claudeModel || 'claude-sonnet-5'
  const cLocation = claudeLocation || 'us-east5'
  let clientPromise: Promise<import('@google/genai').GoogleGenAI> | null = null

  // Vertex access token for the raw Anthropic endpoint (the @google/genai client
  // only speaks Gemini). Reuses the same service-account key file as Gemini, or
  // gcloud ADC when unset; google-auth-library refreshes the token as needed.
  let authPromise: Promise<import('google-auth-library').GoogleAuth> | null = null
  const getVertexToken = async (): Promise<string> => {
    authPromise ??= import('google-auth-library').then(
      ({ GoogleAuth }) =>
        new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          ...(keyFile ? { keyFile } : {}),
        }),
    )
    const auth = await authPromise
    const client = await auth.getClient()
    const { token } = await client.getAccessToken()
    if (!token) throw new Error('failed to mint a Vertex access token (check gcloud ADC / key file)')
    return token
  }

  // Claude on Vertex judge. Forces structured output via a single-tool call whose
  // input_schema is the eval schema, then returns the tool input as a JSON string
  // (so the client parses it exactly like the Gemini path). Throws with the
  // upstream HTTP status attached so a 429 (no quota) surfaces as-is.
  const claudeVertexEval = async (system: string, prompt: string, schema: unknown): Promise<string> => {
    const token = await getVertexToken()
    const url =
      `https://${cLocation}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${cLocation}/publishers/anthropic/models/${cModel}:rawPredict`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ name: 'submit_evaluation', description: 'Return the structured tutor evaluation.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'submit_evaluation' },
      }),
    })
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`
      try {
        const j = (await resp.json()) as { error?: { message?: string } }
        detail = j?.error?.message || detail
      } catch {
        /* non-JSON body */
      }
      const err = new Error(detail) as Error & { status?: number }
      err.status = resp.status
      throw err
    }
    const json = (await resp.json()) as { content?: Array<{ type: string; input?: unknown; text?: string }> }
    const tool = json.content?.find((c) => c.type === 'tool_use')
    if (tool?.input !== undefined) return JSON.stringify(tool.input)
    const textBlock = json.content?.find((c) => c.type === 'text')
    if (textBlock?.text) return textBlock.text
    throw new Error('Claude returned no structured evaluation.')
  }
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
      const { system, prompt, schema, provider } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      // Second judge in the eval panel: Claude on Vertex. Handled separately so a
      // failure (e.g. no Sonnet quota) returns its real status without touching the
      // Gemini client.
      if (provider === 'claude') {
        try {
          const text = await claudeVertexEval(system, prompt, schema)
          res.end(JSON.stringify({ text }))
        } catch (ce) {
          const status = (ce as { status?: number }).status
          res.statusCode = typeof status === 'number' ? status : 500
          res.end(JSON.stringify({ error: ce instanceof Error ? ce.message : String(ce) }))
        }
        return
      }
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
        model: tModel,
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
        env.GEMINI_TRANSLATE_MODEL || 'gemini-2.5-flash-lite',
        // Second eval-panel judge (Claude on Vertex Model Garden).
        env.CLAUDE_JUDGE_MODEL || 'claude-sonnet-5',
        env.VERTEX_CLAUDE_LOCATION || 'us-east5',
      ),
    ],
  }
})
