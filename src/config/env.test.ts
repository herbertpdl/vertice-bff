import { describe, expect, it } from 'vitest'
import { DEFAULT_CORS_ORIGIN, DEFAULT_LEGAL_VERSION, DEV_JWT_SECRET, parseCorsOrigins, parseEnv, parseTrustProxy } from './env.js'

const STRONG_SECRET = 'q7Vx2mP9rT4wZ8kL1nB6cF3hJ5sD0gYa'

describe('parseEnv JWT_SECRET', () => {
  it('refuses to start in production without a secret (no default)', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET: is required/)
  })

  it('refuses to start in production with a secret shorter than 32 bytes', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET: must be at least 32 bytes/)
  })

  it('counts bytes, not characters', () => {
    // 16 two-byte characters = 32 bytes.
    expect(parseEnv({ NODE_ENV: 'production', JWT_SECRET: 'é'.repeat(16) }).JWT_SECRET).toBe('é'.repeat(16))
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: 'é'.repeat(15) })).toThrow(/at least 32 bytes/)
  })

  it.each([DEV_JWT_SECRET, DEV_JWT_SECRET.toUpperCase()])(
    'refuses to start in production with a known placeholder (%s)',
    (secret) => {
      expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: secret })).toThrow(/JWT_SECRET: is a publicly known placeholder/)
    },
  )

  it.each(['dev-secret-change-me', 'change-me-in-production'])('refuses old default/example %s in production', (secret) => {
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: secret })).toThrow(/JWT_SECRET/)
  })

  it('never prints the secret in the failure message', () => {
    const secret = 'leaky-but-too-short'
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    )
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(DEV_JWT_SECRET) }),
    )
  })

  it('accepts a strong secret in production', () => {
    expect(parseEnv({ NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET }).JWT_SECRET).toBe(STRONG_SECRET)
  })

  it('falls back to the shared dev secret outside production', () => {
    expect(parseEnv({}).JWT_SECRET).toBe(DEV_JWT_SECRET)
    expect(parseEnv({ NODE_ENV: 'development', JWT_SECRET: '' }).JWT_SECRET).toBe(DEV_JWT_SECRET)
    expect(parseEnv({ NODE_ENV: 'test' }).JWT_SECRET).toBe(DEV_JWT_SECRET)
  })

  it('keeps the shared dev secret at the HS256 length floor so vertice-api accepts it too', () => {
    expect(Buffer.byteLength(DEV_JWT_SECRET, 'utf8')).toBeGreaterThanOrEqual(32)
  })
})

describe('parseEnv NODE_ENV fails closed', () => {
  it.each(['production', 'Production', 'PRODUCTION', ' production', 'production\n', 'prod', 'staging', 'qa'])(
    'requires a valid secret when NODE_ENV=%j',
    (nodeEnv) => {
      expect(() => parseEnv({ NODE_ENV: nodeEnv })).toThrow(/JWT_SECRET: is required/)
      expect(() => parseEnv({ NODE_ENV: nodeEnv, JWT_SECRET: DEV_JWT_SECRET })).toThrow(/placeholder/)
      expect(parseEnv({ NODE_ENV: nodeEnv, JWT_SECRET: STRONG_SECRET }).JWT_SECRET).toBe(STRONG_SECRET)
    },
  )

  it.each([undefined, '', 'development', 'Development', ' test ', 'TEST'])('allows the dev default when NODE_ENV=%j', (nodeEnv) => {
    expect(parseEnv({ NODE_ENV: nodeEnv }).JWT_SECRET).toBe(DEV_JWT_SECRET)
  })

  it('exposes NODE_ENV normalized', () => {
    expect(parseEnv({ NODE_ENV: ' Production ', JWT_SECRET: STRONG_SECRET }).NODE_ENV).toBe('production')
    expect(parseEnv({}).NODE_ENV).toBe('')
  })
})

describe('parseEnv JWT_SECRET whitespace', () => {
  it('refuses a blank secret (32 spaces) outside dev', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: ' '.repeat(32) })).toThrow(/JWT_SECRET: is required/)
  })

  it('refuses a short secret padded with whitespace to 32 bytes', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: `short${' '.repeat(27)}` })).toThrow(
      /JWT_SECRET: must not have leading or trailing whitespace/,
    )
    expect(() => parseEnv({ NODE_ENV: 'production', JWT_SECRET: ` ${STRONG_SECRET}` })).toThrow(/whitespace/)
  })

  it('falls back to the dev default for a blank secret in development', () => {
    expect(parseEnv({ NODE_ENV: 'development', JWT_SECRET: '   ' }).JWT_SECRET).toBe(DEV_JWT_SECRET)
  })
})

describe('parseEnv CORS_ORIGIN', () => {
  it('defaults to the Expo web dev origin', () => {
    expect(parseEnv({}).CORS_ORIGIN).toEqual([DEFAULT_CORS_ORIGIN])
  })

  it('parses a comma-separated list', () => {
    expect(parseEnv({ CORS_ORIGIN: 'http://localhost:8081, https://app.example.com' }).CORS_ORIGIN).toEqual([
      'http://localhost:8081',
      'https://app.example.com',
    ])
  })

  it('drops blank entries, so an empty value allows no browser origin', () => {
    expect(parseCorsOrigins(' a , ,b,')).toEqual(['a', 'b'])
    expect(parseEnv({ CORS_ORIGIN: '' }).CORS_ORIGIN).toEqual([])
  })
})

describe('parseEnv VERIFY_PASSWORDS', () => {
  it('defaults to true everywhere', () => {
    expect(parseEnv({}).VERIFY_PASSWORDS).toBe(true)
    expect(parseEnv({ NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET }).VERIFY_PASSWORDS).toBe(true)
  })

  it.each([undefined, 'development', 'test'])('may be turned off when NODE_ENV=%j', (nodeEnv) => {
    expect(parseEnv({ NODE_ENV: nodeEnv, VERIFY_PASSWORDS: 'false' }).VERIFY_PASSWORDS).toBe(false)
    expect(parseEnv({ NODE_ENV: nodeEnv, VERIFY_PASSWORDS: ' FALSE ' }).VERIFY_PASSWORDS).toBe(false)
    expect(parseEnv({ NODE_ENV: nodeEnv, VERIFY_PASSWORDS: '0' }).VERIFY_PASSWORDS).toBe(false)
  })

  it.each(['production', 'staging', 'prod'])('refuses false when NODE_ENV=%s', (nodeEnv) => {
    expect(() => parseEnv({ NODE_ENV: nodeEnv, JWT_SECRET: STRONG_SECRET, VERIFY_PASSWORDS: 'false' })).toThrow(
      /VERIFY_PASSWORDS: must not be false/,
    )
  })

  it('refuses a value that is not a boolean instead of reading it as truthy', () => {
    expect(() => parseEnv({ VERIFY_PASSWORDS: 'nope' })).toThrow(/VERIFY_PASSWORDS: must be true or false/)
  })
})

describe('parseEnv TRUST_PROXY', () => {
  it('defaults to false', () => {
    expect(parseEnv({}).TRUST_PROXY).toBe(false)
  })

  it('parses true/false and passes an address list through', () => {
    expect(parseTrustProxy('true')).toBe(true)
    expect(parseTrustProxy(' False ')).toBe(false)
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8')
  })

  it('refuses a hop count, which Fastify would treat as "trust nothing"', () => {
    expect(() => parseEnv({ TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY: must be true, false or a list/)
  })
})

describe('parseEnv rate limits', () => {
  it('defaults to 5 auth attempts per 15 minutes and 300 requests per minute overall', () => {
    expect(parseEnv({})).toMatchObject({
      AUTH_RATE_LIMIT_MAX: 5,
      AUTH_RATE_LIMIT_WINDOW_MS: 900_000,
      AUTH_RATE_LIMIT_MAX_KEYS: 1_000_000,
      RATE_LIMIT_GLOBAL_MAX: 300,
      RATE_LIMIT_GLOBAL_WINDOW_MS: 60_000,
    })
  })

  it('reads overrides and refuses non-positive values', () => {
    expect(parseEnv({ AUTH_RATE_LIMIT_MAX: '10' }).AUTH_RATE_LIMIT_MAX).toBe(10)
    expect(() => parseEnv({ AUTH_RATE_LIMIT_MAX: '0' })).toThrow(/AUTH_RATE_LIMIT_MAX/)
    // An attempt can need 3 new keys (network, IP, email); a smaller cap would refuse everyone.
    expect(() => parseEnv({ AUTH_RATE_LIMIT_MAX_KEYS: '2' })).toThrow(/AUTH_RATE_LIMIT_MAX_KEYS/)
    expect(parseEnv({ AUTH_RATE_LIMIT_MAX_KEYS: '3' }).AUTH_RATE_LIMIT_MAX_KEYS).toBe(3)
  })
})

describe('parseEnv legal versions', () => {
  it('defaults both to the draft version', () => {
    const env = parseEnv({})
    expect(env.TERMS_VERSION).toBe(DEFAULT_LEGAL_VERSION)
    expect(env.HEALTH_DATA_CONSENT_VERSION).toBe(DEFAULT_LEGAL_VERSION)
  })

  it('reads overrides in vertice-api\'s version format', () => {
    const env = parseEnv({ TERMS_VERSION: ' 2026-11-01 ', HEALTH_DATA_CONSENT_VERSION: 'v1.2' })
    expect(env.TERMS_VERSION).toBe('2026-11-01')
    expect(env.HEALTH_DATA_CONSENT_VERSION).toBe('v1.2')
  })

  it.each(['', 'v 1', '2026/10', 'v'.repeat(33)])('refuses %j, which vertice-api would reject', (value) => {
    expect(() => parseEnv({ TERMS_VERSION: value })).toThrow(/TERMS_VERSION/)
    expect(() => parseEnv({ HEALTH_DATA_CONSENT_VERSION: value })).toThrow(/HEALTH_DATA_CONSENT_VERSION/)
  })
})
