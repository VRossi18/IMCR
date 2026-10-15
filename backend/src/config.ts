import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://dev:devpassword@localhost:5432/routing_db'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LLM_PROVIDER: z.enum(['fake', 'anthropic', 'ollama', 'gemini']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1'),
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  /** Tempo máximo de cada chamada ao LLM. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Classificações simultâneas no worker (respeita limites de taxa do provedor). */
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
})

export type Config = z.infer<typeof EnvSchema>

/**
 * `requireLlm: false` é para processos que não classificam (a API): eles não precisam da chave
 * e, no compose, nem a recebem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { requireLlm?: boolean } = {}): Config {
  const config = EnvSchema.parse(env)
  if ((opts.requireLlm ?? true) && config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY é obrigatório quando LLM_PROVIDER=anthropic')
  }
  if ((opts.requireLlm ?? true) && config.LLM_PROVIDER === 'gemini' && !config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY é obrigatório quando LLM_PROVIDER=gemini')
  }
  return config
}
