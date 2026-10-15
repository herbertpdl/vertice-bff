import { describe, expect, it } from 'vitest'
import {
  changePasswordSchema,
  cpfInputSchema,
  deleteAccountSchema,
  emailSchema,
  loginSchema,
  passwordSchema,
  passwordSetupSchema,
  registerSchema,
  updateMeSchema,
} from './schemas.js'

const register = {
  name: 'Nova',
  email: 'nova@vertice.test',
  password: 'secret-123',
  role: 'TRAINER',
  cpf: '52998224725',
  acceptedTermsVersion: 'v1',
}

describe('registerSchema', () => {
  it('accepts a complete trainer body', () => {
    expect(registerSchema.parse(register).cpf).toBe('52998224725')
  })

  it('requires the CPF (vertice-api requires it for a TRAINER)', () => {
    expect(() => registerSchema.parse({ ...register, cpf: undefined })).toThrow()
    expect(() => registerSchema.parse({ ...register, cpf: '' })).toThrow(/CPF must be 11 digits/)
  })

  it.each(['52998224726', '11111111111', '529.982.247-25', '5299822472'])('refuses the CPF %s', (cpf) => {
    expect(() => registerSchema.parse({ ...register, cpf })).toThrow(/CPF must be 11 digits/)
  })

  it('refuses a masked CPF', () => {
    expect(() => registerSchema.parse({ ...register, cpf: '***.***.***-25' })).toThrow(/masked/)
  })

  it('bounds name (255, not blank) and cref (20)', () => {
    expect(() => registerSchema.parse({ ...register, name: ' ' })).toThrow()
    expect(() => registerSchema.parse({ ...register, name: 'a'.repeat(256) })).toThrow()
    expect(registerSchema.parse({ ...register, cref: 'c'.repeat(20) }).cref).toHaveLength(20)
    expect(() => registerSchema.parse({ ...register, cref: 'c'.repeat(21) })).toThrow()
  })
})

describe('emailSchema', () => {
  it('trims, lower-cases and caps at 255', () => {
    expect(emailSchema.parse(' A@Vertice.TEST ')).toBe('a@vertice.test')
    const local = 'a'.repeat(64)
    const long = `${local}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`
    expect(long.length).toBeGreaterThan(255)
    expect(() => emailSchema.parse(long)).toThrow()
  })
})

describe('passwordSchema', () => {
  it('needs 8 characters, not blank, at most 72 UTF-8 bytes; spaces are fine', () => {
    expect(passwordSchema.parse('abcdefgh')).toBe('abcdefgh')
    expect(passwordSchema.parse('a b c d e')).toBe('a b c d e')
    expect(() => passwordSchema.parse('abcdefg')).toThrow()
    expect(() => passwordSchema.parse('        ')).toThrow()
    expect(passwordSchema.parse('a'.repeat(72))).toHaveLength(72)
    expect(() => passwordSchema.parse('a'.repeat(73))).toThrow(/72 bytes/)
    expect(() => passwordSchema.parse('é'.repeat(37))).toThrow(/72 bytes/) // 74 bytes, 37 chars
    expect(passwordSchema.parse('é'.repeat(36))).toHaveLength(36)
  })
})

describe('submitted passwords (login, re-check)', () => {
  it('stay lenient: any non-empty text, capped at 1000 so a huge body is never hashed', () => {
    expect(loginSchema.parse({ email: 'a@b.co', password: 'x' }).password).toBe('x')
    expect(loginSchema.parse({ email: 'a@b.co', password: 'x'.repeat(1000) }).password).toHaveLength(1000)
    expect(() => loginSchema.parse({ email: 'a@b.co', password: '' })).toThrow()
    expect(() => loginSchema.parse({ email: 'a@b.co', password: 'x'.repeat(1001) })).toThrow()
    expect(() => deleteAccountSchema.parse({ password: 'x'.repeat(1001) })).toThrow()
    expect(() => changePasswordSchema.parse({ currentPassword: 'x'.repeat(1001), newPassword: 'abcdefgh' })).toThrow()
  })

  it('counts the cap in UTF-16 units, so astral characters cost two', () => {
    // 500 emoji are 1000 UTF-16 units (and 500 code points): the last accepted password.
    expect(loginSchema.parse({ email: 'a@b.co', password: '😀'.repeat(500) }).password).toHaveLength(1000)
    expect(() => loginSchema.parse({ email: 'a@b.co', password: '😀'.repeat(501) })).toThrow()
    expect(() => deleteAccountSchema.parse({ password: '😀'.repeat(501) })).toThrow()
    expect(() =>
      changePasswordSchema.parse({ currentPassword: '😀'.repeat(501), newPassword: 'abcdefgh' }),
    ).toThrow()
  })

  it('does not apply the new-password policy to the current one', () => {
    expect(changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'abcdefgh' }).currentPassword).toBe('old')
  })
})

describe('passwordSetupSchema', () => {
  it('bounds the token', () => {
    expect(passwordSetupSchema.parse({ token: ' t ', newPassword: 'abcdefgh' }).token).toBe('t')
    expect(() => passwordSetupSchema.parse({ token: 't'.repeat(513), newPassword: 'abcdefgh' })).toThrow()
  })
})

describe('cpfInputSchema', () => {
  it('is valid or empty (empty means none)', () => {
    expect(cpfInputSchema.parse('52998224725')).toBe('52998224725')
    expect(cpfInputSchema.parse('')).toBe('')
    expect(() => cpfInputSchema.parse('52998224726')).toThrow()
    expect(() => cpfInputSchema.parse('1'.repeat(50))).toThrow()
  })
})

describe('updateMeSchema', () => {
  it('bounds name and cref, and checks a CPF that is set', () => {
    expect(updateMeSchema.parse({ cpf: null, cref: null })).toEqual({ cpf: null, cref: null })
    expect(() => updateMeSchema.parse({ name: 'a'.repeat(256) })).toThrow()
    expect(() => updateMeSchema.parse({ cref: 'c'.repeat(21) })).toThrow()
    expect(() => updateMeSchema.parse({ cpf: '52998224726' })).toThrow()
  })
})
