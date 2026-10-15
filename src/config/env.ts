import 'dotenv/config'
import { z } from 'zod'

/**
 * Shared local-dev JWT secret: the BFF's dev default and the value in `.env.example`. vertice-api
 * and vertice-local adopt the same value as their dev default so tokens minted here verify
 * upstream. It is public, so it is refused outside development/test (see
 * {@link PLACEHOLDER_JWT_SECRETS}).
 */
export const DEV_JWT_SECRET = 'vertice-dev-jwt-secret-do-not-use-in-production'

/** HS256 needs a key of at least 256 bits; mirrors vertice-api's `JwtSecretGuard`. */
export const MIN_JWT_SECRET_BYTES = 32

/** Publicly known values (current and past defaults/examples), refused outside dev at any length. */
export const PLACEHOLDER_JWT_SECRETS = [DEV_JWT_SECRET, 'dev-secret-change-me', 'change-me-in-production']

/**
 * Browser origins allowed to call the BFF directly. Only clients running in a browser need this:
 * Expo web (`vertice-mobile` `npm run web`, Metro on :8081). vertice-web-react calls the BFF
 * server-side through its own `/api/*` proxy, so it never needs an entry here.
 */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:8081'

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/**
 * The only NODE_ENV values (after trim + lower-case) that may run on the dev JWT default. Fails
 * closed: anything else (`production`, `prod`, `staging`, a typo) must provide a valid secret.
 */
export const DEV_NODE_ENVS = ['', 'development', 'test']

/**
 * Parses a boolean env var strictly: `true`/`false`/`1`/`0` (trimmed, case-insensitive), or the
 * default when unset or blank. Anything else is an error rather than a silent truthy string.
 */
function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const normalized = (value ?? '').trim().toLowerCase()
      if (normalized === '') return defaultValue
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0') return false
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be true or false' })
      return z.NEVER
    })
}

/**
 * Fastify's `trustProxy`: `false` (default; `req.ip` is the socket peer), `true` (trust every
 * hop; only when the BFF is reachable solely through a proxy that overwrites
 * `X-Forwarded-For`), or a comma-separated list of trusted proxy addresses/CIDRs or proxy-addr
 * names (`loopback`, `linklocal`, `uniquelocal`, e.g. `10.0.0.0/8`). A bare hop count is
 * refused: this Fastify version treats a number as "trust nothing", which would silently put
 * every client behind the proxy into one rate-limit bucket. The rate limits key on `req.ip`.
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  const normalized = (value ?? '').trim()
  if (normalized === '' || normalized.toLowerCase() === 'false') return false
  if (normalized.toLowerCase() === 'true') return true
  return normalized
}

function isPlaceholderSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase()
  return PLACEHOLDER_JWT_SECRETS.some((placeholder) => placeholder.toLowerCase() === normalized)
}

/** vertice-api's consent version format (`CONSENT_VERSION` in its `UserController`). */
export const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

/**
 * The legal texts' current versions until legal review sets real ones. The texts themselves are
 * drafts pending legal review (vertice-api `docs/data-inventory.md`), hence the suffix.
 */
export const DEFAULT_LEGAL_VERSION = '2026-10-draft'

const legalVersion = z
  .string()
  .trim()
  .regex(CONSENT_VERSION_PATTERN, 'must be 1 to 32 letters, digits, dots, underscores or hyphens')
  .default(DEFAULT_LEGAL_VERSION)

const envSchema = z
  .object({
    NODE_ENV: z
      .string()
      .optional()
      .transform((value) => (value ?? '').trim().toLowerCase()),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().default(DEFAULT_CORS_ORIGIN).transform(parseCorsOrigins),
    VERTICE_API_GRPC_HOST: z.string().default('localhost'),
    VERTICE_API_GRPC_PORT: z.coerce.number().default(9090),
    JWT_SECRET: z.string().optional(),
    JWT_EXPIRES_IN: z.string().default('8h'),
    /**
     * Login checks the password through vertice-api's `VerifyCredentials`. `false` restores the
     * old email-only login for the rollout window (until every client has a setup link) and is
     * refused unless NODE_ENV is development or test. That login finds the user through
     * `ListUsers` sent with no token, so it only works against vertice-api's `local` profile: the
     * BFF's service token is deliberately not allowed to list users.
     */
    VERIFY_PASSWORDS: envBoolean(true),
    TRUST_PROXY: z
      .string()
      .optional()
      .refine((value) => !/^\s*\d+\s*$/.test(value ?? ''), {
        message: 'must be true, false or a list of proxy addresses/CIDRs, not a hop count',
      })
      .transform(parseTrustProxy),
    /** Loose per-IP bucket over every route. */
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /** Strict per-IP and per-email buckets on login, register and password setup/change. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
    /** Strict-bucket limit per IPv6 /48 or IPv4 /24; unset means 20 × AUTH_RATE_LIMIT_MAX. */
    AUTH_RATE_LIMIT_NETWORK_MAX: z.coerce.number().int().positive().optional(),
    /**
     * Most strict-bucket keys held in memory; when full, new clients get 429 (fail closed). An
     * attempt can need 3 new keys (network, IP, email), so anything smaller refuses everyone.
     */
    AUTH_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(3).default(1_000_000),
    /** Per-user bucket on `GET /auth/me/export` (every attempt counts): 3 per hour by default. */
    EXPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3),
    EXPORT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
    /**
     * Current version of the Terms of Use / Privacy Policy, and of the health-data consent notice
     * (P1-04), served by `GET /api/legal/versions`. The web shows these texts, sends the version
     * back on register / `POST /auth/me/consent`, and asks again when a stored consent differs.
     * Bump one when its text changes.
     */
    TERMS_VERSION: legalVersion,
    HEALTH_DATA_CONSENT_VERSION: legalVersion,
  })
  .superRefine((value, ctx) => {
    if (DEV_NODE_ENVS.includes(value.NODE_ENV)) return
    if (!value.VERIFY_PASSWORDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VERIFY_PASSWORDS'],
        message: 'must not be false unless NODE_ENV is development or test (login would accept any password)',
      })
    }
    // Messages never echo the secret itself.
    const secret = value.JWT_SECRET
    const scope = 'unless NODE_ENV is development or test'
    let message: string | undefined
    if (!secret || secret.trim().length === 0) {
      message = `is required ${scope}`
    } else if (secret !== secret.trim()) {
      message = `must not have leading or trailing whitespace ${scope}`
    } else if (Buffer.byteLength(secret, 'utf8') < MIN_JWT_SECRET_BYTES) {
      message = `must be at least ${MIN_JWT_SECRET_BYTES} bytes ${scope}`
    } else if (isPlaceholderSecret(secret)) {
      message = `is a publicly known placeholder/dev value; set a random secret ${scope}`
    }
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message })
  })
  .transform((value) => ({ ...value, JWT_SECRET: value.JWT_SECRET?.trim() ? value.JWT_SECRET : DEV_JWT_SECRET }))

export type Env = z.infer<typeof envSchema>

/** Parses and validates `source`; throws an Error listing every invalid variable (no values). */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`Invalid environment configuration, refusing to start:\n${lines.join('\n')}`)
  }
  return result.data
}

export const env = parseEnv(process.env)

export const grpcTarget = `${env.VERTICE_API_GRPC_HOST}:${env.VERTICE_API_GRPC_PORT}`
