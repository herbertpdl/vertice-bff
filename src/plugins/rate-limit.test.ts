import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { emailKey } from './rate-limit.js'

const withEmail = (email: unknown) => ({ body: { email } }) as unknown as FastifyRequest

describe('emailKey', () => {
  it('is a fixed-size SHA-256 of the normalized email, holding no raw address', () => {
    const key = emailKey(withEmail('  Ana@Example.com '))
    expect(key).toMatch(/^email:[0-9a-f]{64}$/)
    expect(key).not.toContain('ana')
    expect(emailKey(withEmail('ana@example.com'))).toBe(key)
  })

  it.each([
    ['a 1 MiB string', `${'a'.repeat(1024 * 1024)}@example.com`],
    ['over 254 characters', `${'a'.repeat(250)}@example.com`],
    ['not an email', 'not-an-email'],
    ['blank', '   '],
    ['not a string', { $ne: '' }],
  ])('gives no email key for %s (the IP and network buckets still apply)', (_why, email) => {
    expect(emailKey(withEmail(email))).toBeUndefined()
  })

  it('handles a missing body', () => {
    expect(emailKey({ body: undefined } as unknown as FastifyRequest)).toBeUndefined()
  })
})
