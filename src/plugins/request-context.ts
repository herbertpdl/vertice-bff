import fp from 'fastify-plugin'
import { requestContext } from '../lib/request-context.js'

/**
 * Opens an empty request context for every request, so every later hook, the
 * route handler and every `await` under it share one store (read by
 * `grpcCall` to forward the caller's identity upstream).
 *
 * Callback style, not `async`, on purpose: `run()` has to wrap the
 * continuation of the hook chain, which is exactly what `done` is.
 */
export default fp(async function requestContextPlugin(app) {
  app.addHook('onRequest', (_request, _reply, done) => {
    requestContext.run({}, done)
  })
})
