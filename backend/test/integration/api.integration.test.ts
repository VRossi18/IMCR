import { UnrecoverableError } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeClassifier } from '../../src/llm/fake.js'
import type { LlmClassifier } from '../../src/llm/types.js'
import type { ClassificationResult } from '../../src/schemas/classification.js'
import type { MessageDto } from '../../src/schemas/api.js'
import { ORIGIN, list, openSse, patch, poll, post, servicesUp, startHarness, type Harness } from './harness.js'

// Requer Postgres e Redis: podman compose -f podman-compose.yaml up -d postgres redis
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
const up = await servicesUp()
// No CI os serviços são obrigatórios: pular aqui daria um verde falso.
if (!up && process.env.CI) throw new Error('Postgres/Redis indisponíveis: os testes de integração não podem ser pulados no CI')

const fake = new FakeClassifier()
let behavior: (text: string) => Promise<ClassificationResult> = (t) => fake.classify(t)
const classifier: LlmClassifier = { name: 'test:programavel', classify: (t) => behavior(t) }

describe.skipIf(!up)('API + fila + worker (Postgres e Redis reais)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness(classifier)
  })
  afterAll(async () => {
    await h?.stop()
  })
  beforeEach(() => {
    behavior = (t) => fake.classify(t)
  })

  const create = async (name: string, text: string) => {
    const res = await post(h.base, name, text)
    expect(res.status).toBe(201)
    return (await res.json()) as MessageDto
  }
  const waitStatus = (id: string, status: MessageDto['status']) =>
    poll(async () => (await list(h.base)).find((m) => m.id === id && m.status === status))

  it('rejeita corpo inválido com 400', async () => {
    expect((await post(h.base, '  ', 'x')).status).toBe(400)
    expect((await post(h.base, 'Ana', '')).status).toBe(400)
  })

  it('fluxo feliz: PENDING → PROCESSING → COMPLETED, com eventos SSE em ordem', async () => {
    const sse = await openSse(h.base)
    expect(sse.status).toBe(200)
    expect(sse.headers.get('content-type')).toContain('text/event-stream')

    const msg = await create('Ana', 'Preciso da segunda via do boleto')
    expect(msg.status).toBe('PENDING')
    const done = await waitStatus(msg.id, 'COMPLETED')
    expect(done.assignedSector).toBe('FINANCIAL')
    expect(typeof done.urgencyScore).toBe('number')
    expect(done.model).toBe('test:programavel') // quem classificou é gravado e exposto

    await poll(async () => sse.events.some((e) => e.message.id === msg.id && e.message.status === 'COMPLETED'))
    expect(sse.events.find((e) => e.message.id === msg.id && e.message.status === 'COMPLETED')?.message.model).toBe('test:programavel')
    const mine = sse.events.filter((e) => e.message.id === msg.id).map((e) => `${e.type}:${e.message.status}`)
    expect(mine).toEqual(['message.created:PENDING', 'message.updated:PROCESSING', 'message.updated:COMPLETED'])
    sse.abort()
  })

  it('processa mensagens concorrentes sem perder nenhuma', async () => {
    const created = await Promise.all(
      Array.from({ length: 15 }, (_, i) => create(`Cliente ${i}`, `Qual o prazo de envio do pedido ${i}?`)),
    )
    await poll(async () => {
      const all = await list(h.base)
      return created.every((c) => all.find((m) => m.id === c.id)?.status === 'COMPLETED')
    }, 20_000)
    const all = await list(h.base)
    for (const c of created) expect(all.find((m) => m.id === c.id)?.assignedSector).toBe('STOCK')
  })

  it('baixa confiança vai para HUMAN_REVIEW', async () => {
    const msg = await create('Bia', 'asdf qwer zxcv')
    const done = await waitStatus(msg.id, 'COMPLETED')
    expect(done.confidenceScore).toBeLessThan(0.5)
    expect(done.assignedSector).toBe('HUMAN_REVIEW')
  })

  it('retentativa: falha duas vezes e conclui na terceira, sem marcar FAILED', async () => {
    const tries = new Map<string, number>()
    behavior = async (t) => {
      const n = (tries.get(t) ?? 0) + 1
      tries.set(t, n)
      if (n < 3) throw new Error('LLM instável')
      return fake.classify(t)
    }
    const msg = await create('Caio', 'retry boleto cobrança')
    const done = await waitStatus(msg.id, 'COMPLETED')
    expect(tries.get('retry boleto cobrança')).toBe(3)
    expect(done.assignedSector).toBe('FINANCIAL')
    expect(h.failedJobs).not.toContain(msg.id)
  })

  it('falha definitiva: vira FAILED e publica o evento', async () => {
    behavior = async () => {
      throw new Error('LLM fora do ar')
    }
    const sse = await openSse(h.base)
    const msg = await create('Duda', 'sempre falha')
    await waitStatus(msg.id, 'FAILED')
    await poll(async () => sse.events.some((e) => e.message.id === msg.id && e.message.status === 'FAILED'))
    expect(h.failedJobs).toContain(msg.id)
    sse.abort()
  })

  it('erro irrecuperável (ex.: chave inválida): FAILED já na 1ª tentativa, sem retentativas', async () => {
    let calls = 0
    behavior = async () => {
      calls++
      throw new UnrecoverableError('chave inválida')
    }
    const msg = await create('Jade', 'qualquer texto')
    await waitStatus(msg.id, 'FAILED')
    await new Promise((r) => setTimeout(r, 1500)) // o backoff do harness é 100 ms: daria tempo de sobra para repetir
    expect(calls).toBe(1)
    expect(h.failedJobs).toContain(msg.id)
    expect((await list(h.base)).find((m) => m.id === msg.id)?.model).toBeNull()
  })

  it('vários clientes SSE recebem o mesmo evento e o fechamento libera os ouvintes', async () => {
    // Os SSE abertos por testes anteriores já foram abortados: nenhum ouvinte pode sobrar.
    await poll(async () => h.activeListeners() === 0)
    const clients = await Promise.all([openSse(h.base), openSse(h.base), openSse(h.base)])
    await poll(async () => h.activeListeners() === 3)

    const msg = await create('Eli', 'dúvida sobre estoque disponível')
    await poll(async () => clients.every((c) => c.events.some((e) => e.message.id === msg.id && e.message.status === 'COMPLETED')))

    clients.forEach((c) => c.abort())
    await Promise.all(clients.map((c) => c.closed))
    await poll(async () => h.activeListeners() === 0)
  })

  it('persiste após reiniciar a API', async () => {
    const msg = await create('Fê', 'preciso de ajuda, o login não funciona')
    await waitStatus(msg.id, 'COMPLETED')
    await h.restartApi()
    const after = (await list(h.base)).find((m) => m.id === msg.id)
    expect(after?.status).toBe('COMPLETED')
    expect(after?.assignedSector).toBe('SUPPORT')
  })

  it('PATCH: setor inválido 400, inexistente 404, válido atualiza métricas', async () => {
    const msg = await create('Gui', 'orçamento para upgrade do plano')
    await waitStatus(msg.id, 'COMPLETED')
    const metricsBefore = (await (await fetch(`${h.base}/api/metrics`)).json()) as { corrected: number; accuracy: number }

    expect((await patch(h.base, msg.id, 'NADA')).status).toBe(400)
    expect((await patch(h.base, '00000000-0000-4000-8000-000000000000', 'SALES')).status).toBe(404)

    const ok = await patch(h.base, msg.id, 'FINANCIAL')
    expect(((await ok.json()) as MessageDto).correctedSector).toBe('FINANCIAL')
    const m = (await (await fetch(`${h.base}/api/metrics`)).json()) as {
      corrected: number
      accuracy: number
      completed: number
    }
    expect(m.corrected).toBe(metricsBefore.corrected + 1)
    expect(m.accuracy).toBeCloseTo(1 - m.corrected / m.completed)

    // corrigir para o mesmo setor da IA não conta como erro
    const same = await patch(h.base, msg.id, 'SALES')
    expect(((await same.json()) as MessageDto).correctedSector).toBe('SALES')
    const m2 = (await (await fetch(`${h.base}/api/metrics`)).json()) as { corrected: number }
    expect(m2.corrected).toBe(metricsBefore.corrected)
  })

  it('resolver e reabrir: persiste, conta nas métricas, publica SSE e respeita o estado da mensagem', async () => {
    const act = (id: string, action: 'resolve' | 'reopen') => fetch(`${h.base}/api/messages/${id}/${action}`, { method: 'POST' })
    const metrics = async () =>
      (await (await fetch(`${h.base}/api/metrics`)).json()) as { resolved: number; accuracy: number | null; total: number }

    const msg = await create('Hana', 'dúvida sobre estoque disponível')
    await waitStatus(msg.id, 'COMPLETED')
    const before = await metrics()
    const sse = await openSse(h.base)

    const resolved = (await (await act(msg.id, 'resolve')).json()) as MessageDto
    expect(resolved.resolvedAt).toEqual(expect.any(String))
    expect((await metrics()).resolved).toBe(before.resolved + 1)
    expect((await metrics()).accuracy).toBe(before.accuracy) // resolver não mexe na precisão da IA
    await poll(async () => sse.events.some((e) => e.message.id === msg.id && e.message.resolvedAt !== null))

    // idempotente: mantém a data original e não publica de novo
    const eventsBefore = sse.events.length
    const again = (await (await act(msg.id, 'resolve')).json()) as MessageDto
    expect(again.resolvedAt).toBe(resolved.resolvedAt)
    await new Promise((r) => setTimeout(r, 300))
    expect(sse.events.length).toBe(eventsBefore)

    // persiste após reiniciar a API (o app.close() espera as conexões SSE abertas, então fecha antes)
    sse.abort()
    await sse.closed
    await h.restartApi()
    expect((await list(h.base)).find((m) => m.id === msg.id)?.resolvedAt).toBe(resolved.resolvedAt)

    const reopened = (await (await act(msg.id, 'reopen')).json()) as MessageDto
    expect(reopened.resolvedAt).toBeNull()
    expect((await metrics()).resolved).toBe(before.resolved)
  })

  it('não resolve mensagem FAILED nem inexistente', async () => {
    behavior = async () => {
      throw new Error('LLM fora do ar')
    }
    const msg = await create('Ivo', 'sempre falha')
    await waitStatus(msg.id, 'FAILED')
    const res = await fetch(`${h.base}/api/messages/${msg.id}/resolve`, { method: 'POST' })
    expect(res.status).toBe(409)
    const missing = await fetch(`${h.base}/api/messages/00000000-0000-4000-8000-000000000000/resolve`, { method: 'POST' })
    expect(missing.status).toBe(404)
  })

  it('CORS: libera a origem do frontend em /api/messages e em /api/events', async () => {
    const res = await fetch(`${h.base}/api/messages`, { headers: { Origin: ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const sse = await openSse(h.base)
    expect(sse.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    sse.abort()
  })
})
