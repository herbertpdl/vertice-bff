import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

export interface AuthUser {
  id: number
  name: string
  email: string
  role: Role
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] })
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, env.JWT_SECRET) as AuthUser
}
