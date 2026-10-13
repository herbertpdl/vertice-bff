import { describe, expect, it } from 'vitest'
import { DEFAULT_CORS_ORIGIN, DEV_JWT_SECRET, parseCorsOrigins, parseEnv } from './env.js'

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
