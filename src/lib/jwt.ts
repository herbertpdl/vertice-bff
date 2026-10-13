import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

export interface AuthUser {
  id: number
  name: string
  email: string
  role: Role
}

// Pinned on both sides so a token signed with any other algorithm (or `none`) is rejected,
// and so the BFF stays in step with vertice-api, which only verifies HS256.
const ALGORITHM = 'HS256' satisfies jwt.Algorithm

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] }) as AuthUser
}
