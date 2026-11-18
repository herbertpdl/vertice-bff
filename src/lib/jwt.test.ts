import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import {
  ADMIN_CHALLENGE_AUDIENCE,
  ADMIN_CHALLENGE_TTL_SECONDS,
  ADMIN_SESSION_MAX_SECONDS,
  ADMIN_SESSION_TTL_SECONDS,
  MOBILE_SESSION_TTL_SECONDS,
  serviceToken,
  signAdminChallenge,
  signAdminToken,
  signToken,
  tokenExpiresAt,
  verifyAdminChallenge,
  verifyToken,
  type AuthUser,
} from './jwt.js'

const user: AuthUser = { id: 1, role: 'TRAINER' }
const scope = { issuer: 'vertice-bff', audience: 'vertice-api' }

describe('signToken / verifyToken', () => {
  it('signs with HS256 and verifies its own tokens', () => {
    const token = signToken(user)
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256')
    expect(verifyToken(token)).toEqual(user)
  })

  it('carries only the identity, the role and the iss/aud/exp scope (no name, no email)', () => {
    const claims = jwt.decode(signToken(user)) as jwt.JwtPayload
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sub'])
    expect(claims).toMatchObject({ sub: '1', role: 'TRAINER', iss: 'vertice-bff', aud: 'vertice-api' })
    expect(claims.exp).toBeGreaterThan(claims.iat!)
  })

  it('rejects a token signed with another HMAC algorithm, even with the right secret', () => {
    const token = jwt.sign({ ...user, sub: '1' }, env.JWT_SECRET, { algorithm: 'HS512', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow(/invalid algorithm/)
  })

  it('rejects an unsigned (alg: none) token', () => {
    const token = jwt.sign({ ...user, sub: '1' }, '', { algorithm: 'none', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow()
  })

  it('rejects a token minted before scoping (no iss, no aud), like the ones issued before this change', () => {
    const legacy = jwt.sign({ id: 1, name: 'Ada', email: 'ada@example.com', role: 'ADMIN' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '8h',
    })
    expect(() => verifyToken(legacy)).toThrow(/jwt issuer invalid|jwt audience invalid/)
  })

  it.each([
    ['another issuer', { ...scope, issuer: 'someone-else' }, /jwt issuer invalid/],
    ['another audience', { ...scope, audience: 'vertice-web' }, /jwt audience invalid/],
  ])('rejects a token with %s', (_, options, error) => {
    const token = jwt.sign({ ...user, sub: '1' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...options })
    expect(() => verifyToken(token)).toThrow(error)
  })

  it('rejects a token without exp', () => {
    const token = jwt.sign({ ...user, sub: '1' }, env.JWT_SECRET, { algorithm: 'HS256', ...scope })
    expect(() => verifyToken(token)).toThrow(/exp required/)
  })

  it('rejects an expired token', () => {
    const iat = Math.floor(Date.now() / 1000) - 120
    const token = jwt.sign({ ...user, sub: '1', iat }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow(/jwt expired/)
  })

  it('reads the user id from sub', () => {
    const token = jwt.sign({ role: 'TRAINER' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope, subject: '42' })
    expect(verifyToken(token)).toEqual({ id: 42, role: 'TRAINER' })
  })

  it('still accepts a token minted with the legacy id claim when it equals sub', () => {
    const token = jwt.sign({ id: 7, sub: '7', role: 'CLIENT' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope })
    expect(verifyToken(token)).toEqual({ id: 7, role: 'CLIENT' })
  })

  it.each([
    ['a legacy id that is not the sub', { id: 1, sub: '2', role: 'ADMIN' }, /subject invalid/],
    ['a legacy id that is the sub as a string', { id: '1', sub: '1', role: 'ADMIN' }, /subject invalid/],
    ['no sub', { id: 1, role: 'ADMIN' }, /subject invalid/],
    ['a non-numeric sub', { sub: 'x', role: 'ADMIN' }, /subject invalid/],
    ['a zero sub', { sub: '0', role: 'ADMIN' }, /subject invalid/],
    ['a non-canonical sub', { sub: '01', role: 'ADMIN' }, /subject invalid/],
    ['a sub beyond the safe integers', { sub: '9007199254740993', role: 'ADMIN' }, /subject invalid/],
    ['an unknown role', { sub: '1', role: 'ROOT' }, /role invalid/],
  ])('rejects a token with %s', (_, payload, error) => {
    const token = jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow(error)
  })

  it('never accepts the service token as a user', () => {
    expect(() => verifyToken(serviceToken())).toThrow(/subject invalid/)
  })
})

describe('mobile session tokens', () => {
  const mobile: AuthUser = { id: 20, role: 'CLIENT', session: 'mobile' }

  it('carry session: "mobile", last 90 days, and round-trip through verifyToken', () => {
    const token = signToken(mobile)
    const claims = jwt.decode(token) as jwt.JwtPayload
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'session', 'sub'])
    expect(claims).toMatchObject({ sub: '20', role: 'CLIENT', session: 'mobile', iss: 'vertice-bff', aud: 'vertice-api' })
    expect(claims.exp! - claims.iat!).toBe(MOBILE_SESSION_TTL_SECONDS)
    expect(MOBILE_SESSION_TTL_SECONDS).toBe(90 * 24 * 60 * 60)
    expect(verifyToken(token)).toEqual(mobile)
  })

  it('leave web tokens as they were: 8h, no session claim, none in the verified user', () => {
    const token = signToken({ id: 20, role: 'CLIENT' })
    const claims = jwt.decode(token) as jwt.JwtPayload
    expect(claims.exp! - claims.iat!).toBe(8 * 60 * 60)
    expect(verifyToken(token)).toStrictEqual({ id: 20, role: 'CLIENT' })
  })

  it.each([['web'], [true], ['']])('reject a session claim other than "mobile" (%s)', (session) => {
    const token = jwt.sign({ sub: '20', role: 'CLIENT', session }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow(/session invalid/)
  })

  it('take an explicit iat, and count the 90 days from it', () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 1
    const claims = jwt.decode(signToken(mobile, { issuedAt })) as jwt.JwtPayload
    expect(claims.iat).toBe(issuedAt)
    expect(claims.exp).toBe(issuedAt + MOBILE_SESSION_TTL_SECONDS)
  })

  it('tokenExpiresAt is the exp as an ISO-8601 instant', () => {
    const token = signToken(mobile)
    const { exp } = jwt.decode(token) as jwt.JwtPayload
    expect(tokenExpiresAt(token)).toBe(new Date(exp! * 1000).toISOString())
  })
})

describe('serviceToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a scoped, short-lived HS256 token for the BFF itself', () => {
    const token = serviceToken()
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256')
    const claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], ...scope }) as jwt.JwtPayload
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sub'])
    expect(claims).toMatchObject({ sub: 'service:bff', role: 'SERVICE', iss: 'vertice-bff', aud: 'vertice-api' })
    expect(claims.exp! - claims.iat!).toBe(60)
  })

  it('is reused while it has time left, and replaced before it expires', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') })
    const first = serviceToken()
    vi.advanceTimersByTime(30_000)
    expect(serviceToken()).toBe(first)

    vi.advanceTimersByTime(20_000) // 50s old: 10s left, under the 15s margin
    const second = serviceToken()
    expect(second).not.toBe(first)
    expect((jwt.decode(second) as jwt.JwtPayload).iat).toBe(Date.parse('2030-01-01T00:00:50Z') / 1000)
  })
})

describe('admin tokens (admin-panel spec B3, vertice-api D6)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const now = () => Math.floor(Date.now() / 1000)
  const adminScope = { ...scope, subject: '1', algorithm: 'HS256' as const }
  /** An ADMIN token with these claims, signed by hand (what signAdminToken refuses to make). */
  const crafted = (claims: Record<string, unknown>) =>
    jwt.sign({ role: 'ADMIN', amr: ['pwd', 'otp'], auth_time: now() - 1, iat: now() - 1, exp: now() + 1799, ...claims }, env.JWT_SECRET, adminScope)

  it('carry role ADMIN, amr ["pwd","otp"], auth_time = iat, 30 minutes, and verify with authTime', () => {
    const authTime = now() - 1
    const token = signAdminToken({ id: 1, authTime, issuedAt: authTime })
    const claims = jwt.decode(token) as jwt.JwtPayload
    expect(Object.keys(claims).sort()).toEqual(['amr', 'aud', 'auth_time', 'exp', 'iat', 'iss', 'role', 'sub'])
    expect(claims).toMatchObject({ sub: '1', role: 'ADMIN', amr: ['pwd', 'otp'], auth_time: authTime, iat: authTime })
    expect(claims.exp! - claims.iat!).toBe(ADMIN_SESSION_TTL_SECONDS)
    expect(ADMIN_SESSION_TTL_SECONDS).toBe(1800)
    expect(verifyToken(token)).toStrictEqual({ id: 1, role: 'ADMIN', authTime })
  })

  it('never expire after auth_time + 12h: a renewal at 11h50m ends exactly at the cap', () => {
    const authTime = now() - (11 * 3600 + 50 * 60)
    const issuedAt = now() - 1
    const claims = jwt.decode(signAdminToken({ id: 1, authTime, issuedAt })) as jwt.JwtPayload
    expect(claims.exp).toBe(authTime + ADMIN_SESSION_MAX_SECONDS)
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(ADMIN_SESSION_TTL_SECONDS)
  })

  it('refuse to sign an iat before auth_time, or past the 12h cap', () => {
    expect(() => signAdminToken({ id: 1, authTime: now(), issuedAt: now() - 5 })).toThrow(/not before auth_time/)
    const authTime = now() - ADMIN_SESSION_MAX_SECONDS
    expect(() => signAdminToken({ id: 1, authTime, issuedAt: authTime + ADMIN_SESSION_MAX_SECONDS })).toThrow(/12h cap/)
  })

  it.each([
    ['the plain 8h ADMIN token /auth/login signs', () => signToken({ id: 1, role: 'ADMIN' })],
    ['no amr', () => crafted({ amr: undefined })],
    ['amr without "otp"', () => crafted({ amr: ['pwd'] })],
    ['amr that is not a list', () => crafted({ amr: 'otp' })],
    ['no auth_time', () => crafted({ auth_time: undefined })],
    ['auth_time after iat', () => crafted({ auth_time: now(), iat: now() - 10, exp: now() + 1700 })],
    ['auth_time 12h + 1s ago', () => crafted({ auth_time: now() - ADMIN_SESSION_MAX_SECONDS - 1, iat: now() - 60, exp: now() + 60 })],
    ['exp - iat of 31 minutes', () => crafted({ exp: now() - 1 + 31 * 60 })],
    ['a mobile session claim', () => crafted({ session: 'mobile' })],
  ])('refuse an ADMIN token with %s', (_, token) => {
    expect(() => verifyToken(token())).toThrow()
  })

  it('ignore amr/auth_time on other roles', () => {
    const token = jwt.sign({ role: 'TRAINER', amr: ['pwd'] }, env.JWT_SECRET, { ...adminScope, expiresIn: 60 })
    expect(verifyToken(token)).toStrictEqual({ id: 1, role: 'TRAINER' })
  })
})

describe('admin challenge (admin-panel spec B2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has its own audience, token_use, amr ["pwd"], no role, 5 minutes, and round-trips', () => {
    const token = signAdminChallenge(1)
    const claims = jwt.decode(token) as jwt.JwtPayload
    expect(Object.keys(claims).sort()).toEqual(['amr', 'aud', 'exp', 'iat', 'iss', 'sub', 'token_use'])
    expect(claims).toMatchObject({ sub: '1', aud: ADMIN_CHALLENGE_AUDIENCE, token_use: 'admin_challenge', amr: ['pwd'] })
    expect(claims.exp! - claims.iat!).toBe(ADMIN_CHALLENGE_TTL_SECONDS)
    expect(verifyAdminChallenge(token)).toEqual({ id: 1 })
  })

  it('is refused by verifyToken, so it authenticates no route', () => {
    expect(() => verifyToken(signAdminChallenge(1))).toThrow(/audience invalid/)
  })

  it('expires at 5 minutes + 1 second', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z'), toFake: ['Date'] })
    const token = signAdminChallenge(1)
    vi.setSystemTime(new Date('2030-01-01T00:04:59Z'))
    expect(verifyAdminChallenge(token)).toEqual({ id: 1 })
    vi.setSystemTime(new Date('2030-01-01T00:05:01Z'))
    expect(() => verifyAdminChallenge(token)).toThrow(/expired/)
  })

  it.each([
    ['a user token', () => signToken({ id: 1, role: 'TRAINER' })],
    ['an admin session token', () => signAdminToken({ id: 1, authTime: Math.floor(Date.now() / 1000), issuedAt: Math.floor(Date.now() / 1000) })],
    ['the service token', () => serviceToken()],
    [
      'the right audience without token_use',
      () => jwt.sign({}, env.JWT_SECRET, { ...scope, audience: ADMIN_CHALLENGE_AUDIENCE, subject: '1', expiresIn: 60 }),
    ],
    [
      'the right audience with a role',
      () =>
        jwt.sign({ token_use: 'admin_challenge', role: 'ADMIN' }, env.JWT_SECRET, {
          ...scope,
          audience: ADMIN_CHALLENGE_AUDIENCE,
          subject: '1',
          expiresIn: 60,
        }),
    ],
  ])('verifyAdminChallenge refuses %s', (_, token) => {
    expect(() => verifyAdminChallenge(token())).toThrow()
  })
})
