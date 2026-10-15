import Anthropic from '@anthropic-ai/sdk'
import { UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { AnthropicClassifier } from '../src/llm/anthropic.js'
import { GeminiClassifier } from '../src/llm/gemini.js'
import { createClassifier } from '../src/llm/index.js'
import { OllamaClassifier } from '../src/llm/ollama.js'
import { SYSTEM_PROMPT, userPrompt } from '../src/llm/prompt.js'
import { CLASSIFY_ATTEMPTS } from '../src/queue/classify.queue.js'
import { shouldMarkFailed } from '../src/worker/processor.js'

const good = {
  sector: 'FINANCIAL',
  sentiment: 'NEUTRAL',
  urgencyScore: 0.3,
  confidenceScore: 0.9,
  summary: 'Segunda via de boleto',
  suggestedAction: 'Gerar segunda via',
}

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: `erro ${status}` } }, `erro ${status}`, new Headers())

function classifierWith(create: ReturnType<typeof vi.fn>) {
  return new AnthropicClassifier({ apiKey: 'k', model: 'claude-teste', timeoutMs: 1234, client: { messages: { create } } as never })
}

describe('AnthropicClassifier: requisição', () => {
  it('usa o modelo configurado, temperatura 0, ferramenta forçada e o schema sem $schema', async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: good }] })
    await classifierWith(create).classify('preciso do boleto')
    const req = create.mock.calls[0]![0]
    expect(req.model).toBe('claude-teste')
    expect(req.temperature).toBe(0)
    expect(req.max_tokens).toBe(512)
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'classify_message' })
    expect(req.tools[0].input_schema).not.toHaveProperty('$schema')
    expect(Object.keys(req.tools[0].input_schema.properties).sort()).toEqual(
      ['confidenceScore', 'sector', 'sentiment', 'suggestedAction', 'summary', 'urgencyScore'],
    )
    expect(req.messages[0].content).toContain('preciso do boleto')
  })

  it('o nome identifica provedor e modelo', () => {
    expect(classifierWith(vi.fn()).name).toBe('anthropic:claude-teste')
  })

  it('o cliente real recebe timeout e maxRetries 2 (sem chamar a rede)', () => {
    const c = new AnthropicClassifier({ apiKey: 'k', model: 'm', timeoutMs: 4321 }) as unknown as {
      client: { timeout: number; maxRetries: number }
    }
    expect(c.client.timeout).toBe(4321)
    expect(c.client.maxRetries).toBe(2)
  })
})

describe('AnthropicClassifier: erros', () => {
  it.each([401, 403, 400, 404])('HTTP %i é permanente: vira UnrecoverableError', async (status) => {
    const create = vi.fn().mockRejectedValue(apiError(status))
    await expect(classifierWith(create).classify('oi')).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it.each([429, 500, 503, 529])('HTTP %i continua retentável', async (status) => {
    const create = vi.fn().mockRejectedValue(apiError(status))
    const err = await classifierWith(create).classify('oi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('erro de rede/timeout genérico propaga sem virar irrecuperável', async () => {
    const create = vi.fn().mockRejectedValue(new Error('timeout'))
    const err = await classifierWith(create).classify('oi').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('resposta cortada por max_tokens é erro retentável', async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: good }] })
    const err = await classifierWith(create).classify('oi').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringContaining('max_tokens') })
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('saída que viola o schema (setor inválido, nota fora de 0..1) é rejeitada', async () => {
    for (const bad of [{ ...good, sector: 'HUMAN_REVIEW' }, { ...good, confidenceScore: 1.5 }, { ...good, summary: 1 }]) {
      const create = vi.fn().mockResolvedValue({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: bad }] })
      await expect(classifierWith(create).classify('oi')).rejects.toThrow()
    }
  })
})

function geminiFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

function geminiOk(text: string, finishReason = 'STOP') {
  return geminiFetch(200, { candidates: [{ content: { parts: [{ text }] }, finishReason }] })
}

describe('GeminiClassifier: requisição', () => {
  it('usa o modelo configurado, temperatura 0 e o schema sem $schema/minimum/maximum', async () => {
    const fetchFn = geminiOk(JSON.stringify(good))
    await new GeminiClassifier({ apiKey: 'k', model: 'gemini-teste', timeoutMs: 1234, fetchFn }).classify('preciso do boleto')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toContain('gemini-teste:generateContent')
    expect(url).toContain('key=k')
    const req = JSON.parse(init.body)
    expect(req.generationConfig.temperature).toBe(0)
    expect(req.generationConfig.responseMimeType).toBe('application/json')
    const schema = req.generationConfig.responseSchema
    expect(schema).not.toHaveProperty('$schema')
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"/)
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['confidenceScore', 'sector', 'sentiment', 'suggestedAction', 'summary', 'urgencyScore'],
    )
    expect(req.contents[0].parts[0].text).toContain('preciso do boleto')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('o nome identifica provedor e modelo', () => {
    expect(new GeminiClassifier({ apiKey: 'k', model: 'gemini-teste', timeoutMs: 1000 }).name).toBe('gemini:gemini-teste')
  })
})

describe('GeminiClassifier: erros', () => {
  it.each([400, 401, 403, 404])('HTTP %i é permanente: vira UnrecoverableError', async (status) => {
    const fetchFn = geminiFetch(status, { error: { code: status, message: `erro ${status}` } })
    const classifier = new GeminiClassifier({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchFn })
    await expect(classifier.classify('oi')).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it.each([429, 500, 503])('HTTP %i continua retentável', async (status) => {
    const fetchFn = geminiFetch(status, { error: { code: status, message: `erro ${status}` } })
    const classifier = new GeminiClassifier({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchFn })
    const err = await classifier.classify('oi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('erro de rede/timeout genérico propaga sem virar irrecuperável', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('timeout'))
    const classifier = new GeminiClassifier({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchFn })
    const err = await classifier.classify('oi').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('resposta interrompida por finishReason diferente de STOP é erro retentável', async () => {
    const fetchFn = geminiOk(JSON.stringify(good), 'MAX_TOKENS')
    const classifier = new GeminiClassifier({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchFn })
    const err = await classifier.classify('oi').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringContaining('MAX_TOKENS') })
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('saída que viola o schema (setor inválido, nota fora de 0..1) é rejeitada', async () => {
    for (const bad of [{ ...good, sector: 'HUMAN_REVIEW' }, { ...good, confidenceScore: 1.5 }, { ...good, summary: 1 }]) {
      const classifier = new GeminiClassifier({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchFn: geminiOk(JSON.stringify(bad)) })
      await expect(classifier.classify('oi')).rejects.toThrow()
    }
  })
})

describe('shouldMarkFailed', () => {
  it('marca FAILED só quando não haverá nova tentativa', () => {
    expect(shouldMarkFailed({ attemptsMade: 1 }, new Error('x'))).toBe(false)
    expect(shouldMarkFailed({ attemptsMade: CLASSIFY_ATTEMPTS - 1 }, new Error('x'))).toBe(false)
    expect(shouldMarkFailed({ attemptsMade: CLASSIFY_ATTEMPTS }, new Error('x'))).toBe(true)
  })
  it('erro irrecuperável marca FAILED já na primeira tentativa', () => {
    expect(shouldMarkFailed({ attemptsMade: 1 }, new UnrecoverableError('chave inválida'))).toBe(true)
  })
})

describe('config e factory', () => {
  it('requireLlm:false dispensa a chave (processo da API); o padrão exige', () => {
    const env = { LLM_PROVIDER: 'anthropic' }
    expect(() => loadConfig(env)).toThrow(/ANTHROPIC_API_KEY/)
    expect(() => loadConfig(env, { requireLlm: false })).not.toThrow()
    expect(() => loadConfig({ ...env, ANTHROPIC_API_KEY: 'k' })).not.toThrow()
  })
  it('gemini também exige GEMINI_API_KEY quando requireLlm', () => {
    const env = { LLM_PROVIDER: 'gemini' }
    expect(() => loadConfig(env)).toThrow(/GEMINI_API_KEY/)
    expect(() => loadConfig(env, { requireLlm: false })).not.toThrow()
    expect(() => loadConfig({ ...env, GEMINI_API_KEY: 'k' })).not.toThrow()
  })
  it('padrões de timeout e concorrência, e validação dos limites', () => {
    const c = loadConfig({})
    expect(c.LLM_TIMEOUT_MS).toBe(30_000)
    expect(c.LLM_CONCURRENCY).toBe(5)
    expect(c.ANTHROPIC_MODEL).toBe('claude-haiku-4-5-20251001')
    expect(() => loadConfig({ LLM_TIMEOUT_MS: '0' })).toThrow()
    expect(() => loadConfig({ LLM_CONCURRENCY: '0' })).toThrow()
  })
  it('createClassifier devolve o adaptador com o nome esperado', () => {
    expect(createClassifier(loadConfig({})).name).toBe('fake')
    expect(createClassifier(loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })).name).toBe(
      'anthropic:claude-haiku-4-5-20251001',
    )
    expect(createClassifier(loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).name).toBe('gemini:gemini-flash-latest')
    expect(createClassifier(loadConfig({ LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'llama3.1' })).name).toBe('ollama:llama3.1')
  })
  it('Ollama passa um AbortSignal de timeout para o fetch', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: JSON.stringify(good) } })))
    await new OllamaClassifier('http://x', 'm', fetchFn, 500).classify('oi')
    expect(fetchFn.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('prompt', () => {
  it('define o critério de pontuação e manda ambíguas para confiança baixa', () => {
    expect(SYSTEM_PROMPT).toMatch(/urgencyScore/)
    expect(SYSTEM_PROMPT).toMatch(/confidenceScore/)
    expect(SYSTEM_PROMPT).toMatch(/menos de 0,5/)
    expect(SYSTEM_PROMPT).toMatch(/saudação/i)
  })
  it('mantém as regras do spec e a defesa contra injeção', () => {
    for (const s of ['FINANCIAL', 'STOCK', 'SUPPORT', 'SALES', 'ANGRY', 'CRITICAL']) expect(SYSTEM_PROMPT).toContain(s)
    expect(SYSTEM_PROMPT).toMatch(/ignore quaisquer instruções/)
  })
  it('a mensagem do cliente vai entre aspas triplas', () => {
    expect(userPrompt('olá')).toBe('Mensagem a analisar:\n"""\nolá\n"""')
  })
})
