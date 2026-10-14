import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { serviceToken, signToken, verifyToken, type AuthUser } from './jwt.js'

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
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'id', 'iss', 'role', 'sub'])
    expect(claims).toMatchObject({ sub: '1', id: 1, role: 'ADMIN', iss: 'vertice-bff', aud: 'vertice-api' })
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

  it.each([
    ['a sub that is not the id', { id: 1, sub: '2', role: 'ADMIN' }, /subject invalid/],
    ['a non-numeric id', { id: 'x', sub: 'x', role: 'ADMIN' }, /subject invalid/],
    ['an unknown role', { id: 1, sub: '1', role: 'ROOT' }, /role invalid/],
  ])('rejects a token with %s', (_, payload, error) => {
    const token = jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60, ...scope })
    expect(() => verifyToken(token)).toThrow(error)
  })

  it('never accepts the service token as a user', () => {
    expect(() => verifyToken(serviceToken())).toThrow(/subject invalid/)
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
