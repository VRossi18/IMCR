import { Worker } from 'bullmq'
import { loadConfig } from '../config.js'
import { createDb } from '../db/client.js'
import { createRedisBus } from '../events/bus.js'
import { createClassifier } from '../llm/index.js'
import { CLASSIFY_ATTEMPTS, CLASSIFY_QUEUE, createQueueConnection, type ClassifyJob } from '../queue/classify.queue.js'
import { createMessagesRepo } from '../repo/messages.js'
import { markFailed, processMessage, shouldMarkFailed } from '../worker/processor.js'

const config = loadConfig()
// As migrações rodam na API; o worker só precisa do banco já migrado.
const { db, sql } = createDb(config.DATABASE_URL, config.DB_POOL_MAX)
const classifier = createClassifier(config)
const deps = {
  repo: createMessagesRepo(db),
  bus: createRedisBus(config.REDIS_URL),
  classifier,
  confidenceThreshold: config.CONFIDENCE_THRESHOLD,
  log: (entry: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', ...entry })),
}

const connection = createQueueConnection(config.REDIS_URL)
const worker = new Worker<ClassifyJob>(CLASSIFY_QUEUE, (job) => processMessage(deps, job.data.messageId), {
  connection,
  concurrency: config.LLM_CONCURRENCY,
  // Maior que o pior caso de uma classificação (timeout × (1 + retentativas do SDK)): evita o job
  // ser considerado travado e processado em duplicidade.
  lockDuration: Math.max(120_000, config.LLM_TIMEOUT_MS * 4),
})

worker.on('failed', (job, err) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'classify_failed',
      jobId: job?.id,
      attempt: `${job?.attemptsMade}/${CLASSIFY_ATTEMPTS}`,
      classifier: classifier.name,
      error: err.message,
    }),
  )
  if (job && shouldMarkFailed(job, err)) void markFailed(deps, job.data.messageId)
})

console.log(
  JSON.stringify({ level: 'info', event: 'worker_started', classifier: classifier.name, concurrency: config.LLM_CONCURRENCY }),
)

const shutdown = async () => {
  await worker.close()
  await deps.bus.close()
  connection.disconnect()
  await sql.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
