import closeWithGrace from 'close-with-grace'
import { buildApp } from './app.js'
import { env } from './config/env.js'

const app = await buildApp()

try {
  await app.listen({ port: env.PORT, host: env.HOST })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

closeWithGrace(async ({ err }) => {
  if (err) app.log.error(err)
  await app.close()
})
