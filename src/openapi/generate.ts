import { buildApp } from '../app.js'
import { renderRouteReference, replaceRouteReference } from './reference.js'

/**
 * The two generated files, as text: `docs/openapi.json` and `docs/api-contract.md` (its route
 * reference replaced). Deterministic: no timestamps, no env values, fixed ordering. Used by
 * `scripts/generate-openapi.ts` (writes or checks them) and by the test that keeps them current.
 */
export async function generateOpenapi(input: { contract: string; version: string }) {
  const app = await buildApp({ openapi: { version: input.version } })
  try {
    await app.ready()
    const document = app.swagger()
    return {
      spec: JSON.stringify(document, null, 2) + '\n',
      contract: replaceRouteReference(input.contract, renderRouteReference(document as never)),
    }
  } finally {
    await app.close()
  }
}
