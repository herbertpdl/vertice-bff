import 'dotenv/config'
import { z } from 'zod'

/**
 * Shared local-dev JWT secret. The same value is used by `.env.example`, vertice-local and
 * vertice-api's default, so tokens minted here verify upstream. It is public, so production
 * refuses it (see {@link PLACEHOLDER_JWT_SECRETS}).
 */
export const DEV_JWT_SECRET = 'vertice-dev-jwt-secret-do-not-use-in-production'

/** HS256 needs a key of at least 256 bits; mirrors vertice-api's `JwtSecretGuard`. */
export const MIN_JWT_SECRET_BYTES = 32

/** Publicly known values (current and past defaults/examples), refused in production at any length. */
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

function isPlaceholderSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase()
  return PLACEHOLDER_JWT_SECRETS.some((placeholder) => placeholder.toLowerCase() === normalized)
}

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().default(DEFAULT_CORS_ORIGIN).transform(parseCorsOrigins),
    VERTICE_API_GRPC_HOST: z.string().default('localhost'),
    VERTICE_API_GRPC_PORT: z.coerce.number().default(9090),
    JWT_SECRET: z.string().optional(),
    JWT_EXPIRES_IN: z.string().default('8h'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return
    // Messages never echo the secret itself.
    const secret = value.JWT_SECRET
    let message: string | undefined
    if (!secret) {
      message = 'is required when NODE_ENV=production'
    } else if (Buffer.byteLength(secret, 'utf8') < MIN_JWT_SECRET_BYTES) {
      message = `must be at least ${MIN_JWT_SECRET_BYTES} bytes when NODE_ENV=production`
    } else if (isPlaceholderSecret(secret)) {
      message = 'is a publicly known placeholder/dev value; set a random secret when NODE_ENV=production'
    }
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message })
  })
  .transform((value) => ({ ...value, JWT_SECRET: value.JWT_SECRET || DEV_JWT_SECRET }))

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
