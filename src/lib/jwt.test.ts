import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { signToken, verifyToken, type AuthUser } from './jwt.js'

const user: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com', role: 'ADMIN' }

describe('jwt', () => {
  it('signs with HS256 and verifies its own tokens', () => {
    const token = signToken(user)
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256')
    expect(verifyToken(token)).toMatchObject(user)
  })

  it('rejects a token signed with another HMAC algorithm, even with the right secret', () => {
    const token = jwt.sign(user, env.JWT_SECRET, { algorithm: 'HS512' })
    expect(() => verifyToken(token)).toThrow(/invalid algorithm/)
  })

  it('rejects an unsigned (alg: none) token', () => {
    const token = jwt.sign(user, '', { algorithm: 'none' })
    expect(() => verifyToken(token)).toThrow()
  })
})
