import { z } from 'zod'
import { CONSENT_VERSION_PATTERN } from '../../config/env.js'

/** vertice-api's `@Password` policy: not blank, at least 8 characters, at most 72 UTF-8 bytes (bcrypt's limit). */
export const PASSWORD_MIN_CHARS = 8
export const PASSWORD_MAX_BYTES = 72

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_CHARS, `Password must be at least ${PASSWORD_MIN_CHARS} characters`)
  .refine((value) => value.trim().length > 0, 'Password must not be blank')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES,
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  )

/** Trimmed and lower-cased, the way vertice-api stores emails. */
export const emailSchema = z.string().trim().toLowerCase().email()

/**
 * A consent text version (Terms of Use / Privacy Policy, health-data notice) in vertice-api's
 * format, e.g. `2026-10-draft` or `v1.2`.
 */
export const consentVersionSchema = z
  .string()
  .regex(CONSENT_VERSION_PATTERN, 'Version must be 1 to 32 letters, digits, dots, underscores or hyphens')

export const loginSchema = z.object({
  email: emailSchema,
  // No policy here: login only checks what was stored, and a wrong password must get the same
  // 401 as an unknown email, not a 400 that says something about the input.
  password: z.string().min(1),
})

export const registerSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
  // Public sign-up is for trainers only: a CLIENT is created by their trainer (POST /clients),
  // which links them to the roster. Trainer onboarding rules (CREF, approval) are PROD-BFF-002.
  role: z.literal('TRAINER'),
  cpf: z.string().optional(),
  cref: z.string().optional(),
  // The Terms of Use / Privacy Policy version the user accepted on the form (P1-04). Required:
  // no account is created without an acceptance on record. Any well-formed version is accepted,
  // not only the current `TERMS_VERSION`, so a web build one release behind still registers.
  acceptedTermsVersion: consentVersionSchema,
})

/** `POST /auth/me/consent`: the caller consents, for themself, to one text in one version. */
export const recordConsentSchema = z.object({
  type: z.enum(['TERMS', 'HEALTH_DATA']),
  version: consentVersionSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})

export const passwordSetupSchema = z.object({
  token: z.string().trim().min(1),
  newPassword: passwordSchema,
})
