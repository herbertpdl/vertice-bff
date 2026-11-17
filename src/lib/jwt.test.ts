import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { MOBILE_SESSION_TTL_SECONDS, serviceToken, signToken, tokenExpiresAt, verifyToken, type AuthUser } from './jwt.js'

const user: AuthUser = { id: 1, role: 'ADMIN' }
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
    expect(claims).toMatchObject({ sub: '1', role: 'ADMIN', iss: 'vertice-bff', aud: 'vertice-api' })
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
