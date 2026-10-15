import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'
import { ClassificationSchema, type ClassificationResult } from '../schemas/classification.js'
import { SYSTEM_PROMPT, userPrompt } from './prompt.js'
import type { LlmClassifier } from './types.js'

export interface GeminiOptions {
  apiKey: string
  model: string
  /** Tempo máximo de cada chamada, em ms. */
  timeoutMs: number
  fetchFn?: typeof fetch
}

interface GeminiErrorBody {
  error?: { code?: number; status?: string; message?: string }
}

interface GeminiResponseBody {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
}

/**
 * Chave inválida, sem permissão, modelo inexistente ou pedido malformado (400/401/403/404):
 * repetir não adianta, vira UnrecoverableError e o BullMQ marca o job como falho sem gastar tentativas.
 * Limite de taxa (429), 5xx e timeout continuam retentáveis.
 */
function isPermanent(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404
}

export class GeminiClassifier implements LlmClassifier {
  readonly name: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(opts: GeminiOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.timeoutMs = opts.timeoutMs
    this.fetchFn = opts.fetchFn ?? fetch
    this.name = `gemini:${opts.model}`
  }

  async classify(rawContent: string): Promise<ClassificationResult> {
    const res = await this.fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt(rawContent) }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: responseSchema(),
            // Classificação não precisa de raciocínio estendido; sem isso o Flash "pensa" por ~1 min por chamada.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    )

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as GeminiErrorBody
      const message = body.error?.message ?? `Gemini respondeu ${res.status}`
      if (isPermanent(res.status)) throw new UnrecoverableError(`Gemini recusou a chamada: ${message}`)
      throw new Error(message)
    }

    const body = (await res.json()) as GeminiResponseBody
    const candidate = body.candidates?.[0]
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new Error(`Resposta da LLM interrompida: ${candidate.finishReason}`)
    }
    const text = candidate?.content?.parts?.[0]?.text
    if (!text) throw new Error('Resposta da LLM sem conteúdo')
    return ClassificationSchema.parse(JSON.parse(text))
  }
}

/**
 * Schema OpenAPI (subconjunto aceito pelo Gemini) derivado do Zod: sem `$schema` nem
 * `minimum`/`maximum`/`additionalProperties`, que o Gemini não reconhece.
 */
function responseSchema(): Record<string, unknown> {
  return strip(z.toJSONSchema(ClassificationSchema) as Record<string, unknown>) as Record<string, unknown>
}

const UNSUPPORTED_KEYS = new Set(['$schema', 'additionalProperties', 'minimum', 'maximum'])

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (UNSUPPORTED_KEYS.has(key)) continue
      out[key] = strip(val)
    }
    return out
  }
  return value
}
