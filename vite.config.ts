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

  return {
    name: 'tutor-eval-vertex-proxy',
    configureServer(server) {
      server.middlewares.use('/api/evaluate-tutor', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/evaluate-tutor', handler)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
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
