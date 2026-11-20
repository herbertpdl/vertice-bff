import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { serviceToken, verifyToken } from '../lib/jwt.js'
import { AI_TOKEN_AUDIENCE, AI_TOKEN_TTL_SECONDS, signAiServiceToken } from './token.js'

describe('signAiServiceToken', () => {
  const token = signAiServiceToken({ id: 10, role: 'TRAINER' })

  it('signs the claims vertice-ai requires, with SERVICE_JWT_SECRET and HS256', () => {
    const claims = jwt.verify(token, env.SERVICE_JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'vertice-bff',
      audience: 'vertice-ai',
    }) as jwt.JwtPayload
    expect(claims).toMatchObject({ sub: 'service:bff', uid: 10, role: 'TRAINER', aud: AI_TOKEN_AUDIENCE })
    expect(claims.exp! - claims.iat!).toBe(AI_TOKEN_TTL_SECONDS)
    expect(jwt.decode(token, { complete: true })!.header.alg).toBe('HS256')
  })

  it('is not signed with JWT_SECRET and is never a user token', () => {
    expect(env.SERVICE_JWT_SECRET).not.toBe(env.JWT_SECRET)
    expect(() => jwt.verify(token, env.JWT_SECRET)).toThrow()
    expect(() => verifyToken(token)).toThrow()
  })

  it('is not the vertice-api service token', () => {
    expect(token).not.toBe(serviceToken())
    expect((jwt.decode(serviceToken()) as jwt.JwtPayload).aud).toBe('vertice-api')
  })

  it('is minted per call, not cached', () => {
    expect(jwt.decode(signAiServiceToken({ id: 11, role: 'TRAINER' }))).toMatchObject({ uid: 11 })
  })

  it('refuses an invalid user id', () => {
    expect(() => signAiServiceToken({ id: 0, role: 'TRAINER' })).toThrow()
  })
})
