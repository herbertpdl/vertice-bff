import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'

/** `GET /legal/versions`: the current version of each legal text (P1-04). */
export interface LegalVersions {
  /** Terms of Use / Privacy Policy: sent as `acceptedTermsVersion` on register, `TERMS` consent. */
  terms: string
  /** Health-data consent notice (LGPD art. 11, I): sent as the `HEALTH_DATA` consent. */
  healthData: string
}

/**
 * Public and cacheable: the same answer for everyone, no personal data, and the web needs it on
 * the registration form, before there is a session. It changes only on a deploy that bumps
 * `TERMS_VERSION` or `HEALTH_DATA_CONSENT_VERSION`, so a few minutes of caching is harmless.
 */
export default async function legalRoutes(app: FastifyInstance) {
  app.get(
    '/versions',
    { config: { cacheControl: 'public, max-age=300' } },
    async (): Promise<LegalVersions> => ({ terms: env.TERMS_VERSION, healthData: env.HEALTH_DATA_CONSENT_VERSION }),
  )
}
