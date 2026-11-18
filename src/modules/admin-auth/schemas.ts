import { z } from 'zod'
import { loginSchema } from '../auth/schemas.js'
import { utf16String } from '../../lib/validation.js'

/** `POST /admin/auth/login`: the same body as `POST /auth/login` (email, password; no policy). */
export const adminLoginSchema = loginSchema

/** The longest challenge accepted, raw (a real one is about 250 characters). */
export const ADMIN_CHALLENGE_MAX = 2048

/** The challenge `POST /admin/auth/login` returned. Opaque to clients; only the BFF reads it. */
const challengeSchema = utf16String(ADMIN_CHALLENGE_MAX).min(1)

/** `POST /admin/auth/enroll`. */
export const adminEnrollSchema = z.object({ challenge: challengeSchema }).meta({ id: 'AdminEnrollRequest' })

/** `POST /admin/auth/verify`: the code is exactly six ASCII digits, as vertice-api requires. */
export const adminVerifySchema = z
  .object({
    challenge: challengeSchema,
    code: z.string().regex(/^[0-9]{6}$/, 'expected the 6-digit code from the authenticator app'),
  })
  .meta({ id: 'AdminVerifyRequest' })
