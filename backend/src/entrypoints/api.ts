import { buildServer } from '../api/server.js'
import { loadConfig } from '../config.js'
import { createDb, runMigrations } from '../db/client.js'
import { createRedisBus } from '../events/bus.js'
import { createClassifyQueue } from '../queue/classify.queue.js'
import { createMessagesRepo } from '../repo/messages.js'

const config = loadConfig(process.env, { requireLlm: false })
const { db, sql } = createDb(config.DATABASE_URL, config.DB_POOL_MAX)
await runMigrations(db)

const bus = createRedisBus(config.REDIS_URL)
const queue = createClassifyQueue(config.REDIS_URL)
const app = await buildServer({ repo: createMessagesRepo(db), bus, queue, corsOrigin: config.CORS_ORIGIN })

const shutdown = async () => {
  await app.close()
  await queue.close()
  await bus.close()
  await sql.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
