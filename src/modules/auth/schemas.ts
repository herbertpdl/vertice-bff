import { z } from 'zod'
import { CONSENT_VERSION_PATTERN } from '../../config/env.js'
import { isValidCpf } from '../../lib/cpf.js'
import { requiredText, utf16String } from '../../lib/validation.js'

/** vertice-api's `@Password` policy: not blank, at least 8 characters, at most 72 UTF-8 bytes (bcrypt's limit). */
export const PASSWORD_MIN_CHARS = 8
export const PASSWORD_MAX_BYTES = 72

export const passwordSchema = z
  .string()
  // Every character is at least one byte: a cheap bound before the byte count below.
  .max(PASSWORD_MAX_BYTES, `Password must be at most ${PASSWORD_MAX_BYTES} bytes`)
  // Zod 4's `.min()` counts code points; the API counts UTF-16 units (Java), so 4 emoji are 8 there.
  .refine((value) => value.length >= PASSWORD_MIN_CHARS, `Password must be at least ${PASSWORD_MIN_CHARS} characters`)
  .meta({ minLength: PASSWORD_MIN_CHARS })
  .refine((value) => value.trim().length > 0, 'Password must not be blank')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES,
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  )

/** Trimmed and lower-cased, the way vertice-api stores emails. */
export const emailSchema = z.string().trim().toLowerCase().email().max(255)

/**
 * A password as login or a re-check sends it. No policy, on purpose (uniform "Invalid email or
 * password"); only a sanity cap, so a huge body is never hashed. The cap counts UTF-16 units
 * (`utf16String`), not code points: 1000 astral characters are 2000 units and are refused here,
 * before any `VerifyCredentials` call.
 */
export const LOGIN_PASSWORD_MAX = 1000
export const submittedPasswordSchema = utf16String(LOGIN_PASSWORD_MAX).min(1)

/** `cref`: optional, at most 20 characters, no format (vertice-api `VARCHAR(20)`). */
export const crefSchema = utf16String(20).trim()

/**
 * A CPF as a client sends it. The BFF's own mask (`***.***.***-25`, see `lib/cpf.ts`) is refused:
 * echoing a masked detail back would otherwise reach vertice-api as the new CPF. Otherwise 11 digits
 * with valid check digits, or `''`, which means "none" (vertice-api #65): create sends it upstream
 * as is, and on a PATCH it removes the CPF, as `null` does.
 */
export const cpfInputSchema = z
  .string()
  .max(20)
  .refine((cpf) => !cpf.includes('*'), 'Send the full CPF, not the masked one')
  .refine((cpf) => cpf === '' || cpf.includes('*') || isValidCpf(cpf), 'CPF must be 11 digits, with valid check digits')

/** A CPF that must be there (a TRAINER's): 11 digits, valid check digits. */
export const requiredCpfSchema = z
  .string()
  .max(20)
  .refine((cpf) => cpf.includes('*') || isValidCpf(cpf), 'CPF must be 11 digits, with valid check digits')
  .refine((cpf) => !cpf.includes('*'), 'Send the full CPF, not the masked one')

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
  password: submittedPasswordSchema,
}).meta({ id: 'LoginRequest' })

export const registerSchema = z.object({
  name: requiredText(255),
  email: emailSchema,
  password: passwordSchema,
  // Public sign-up is for trainers only: a CLIENT is created by their trainer (POST /clients),
  // which links them to the roster. Trainer onboarding rules (CREF, approval) are PROD-BFF-002.
  role: z.literal('TRAINER'),
  // Required for a TRAINER (vertice-api's `@Cpf`), digits only, with check digits.
  cpf: requiredCpfSchema,
  cref: crefSchema.optional(),
  // The Terms of Use / Privacy Policy version the user accepted on the form (P1-04). Required:
  // no account is created without an acceptance on record. Any well-formed version is accepted,
  // not only the current `TERMS_VERSION`, so a web build one release behind still registers.
  acceptedTermsVersion: consentVersionSchema,
}).meta({ id: 'RegisterRequest' })

/** `POST /auth/me/consent`: the caller consents, for themself, to one text in one version. */
export const recordConsentSchema = z.object({
  type: z.enum(['TERMS', 'HEALTH_DATA']),
  version: consentVersionSchema,
}).meta({ id: 'ConsentRequest' })

export const changePasswordSchema = z.object({
  currentPassword: submittedPasswordSchema,
  newPassword: passwordSchema,
}).meta({ id: 'ChangePasswordRequest' })

export const passwordSetupSchema = z.object({
  token: utf16String(512).trim().min(1),
  newPassword: passwordSchema,
}).meta({ id: 'PasswordSetupRequest' })

/**
 * `PATCH /auth/me`: the caller corrects their own profile (LGPD art. 18 III). Every field is
 * optional and an omitted one keeps the stored value, since vertice-api's `UpdateUser` replaces
 * every field (the route reads the self view and sends the rest back). `cpf`: a string sets it
 * (the mask `GET /auth/me` returns is refused), `null` removes it, which only a CLIENT may do: a
 * TRAINER's CPF is required. `cref` is a trainer's only. The role can't change: a `role` key is
 * stripped and the stored role is sent.
 */
export const updateMeSchema = z.object({
  name: requiredText(255).optional(),
  // No verification flow yet: the new address is used as is (follow-up P1-06).
  email: emailSchema.optional(),
  cpf: cpfInputSchema.nullable().optional(),
  cref: crefSchema.nullable().optional(),
}).meta({ id: 'UpdateMeRequest' })

/**
 * `DELETE /auth/me`: the caller's current password, re-checked before the account is deleted,
 * so a stolen session alone can't delete it.
 */
export const deleteAccountSchema = z.object({
  password: submittedPasswordSchema,
}).meta({ id: 'DeleteAccountRequest' })
