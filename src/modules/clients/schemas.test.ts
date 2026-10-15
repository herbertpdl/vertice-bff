import { describe, expect, it } from 'vitest'
import { clientCreateSchema, clientUpdateSchema } from './schemas.js'

// vertice-api #65 (P1-04, D1): a CPF is optional for a CLIENT. Empty or absent creates or keeps
// the client without one (stored as NULL); a CPF that is set is still validated upstream.
describe.each([
  ['clientCreateSchema', clientCreateSchema],
  ['clientUpdateSchema', clientUpdateSchema],
] as const)('%s CPF', (_name, schema) => {
  const body = { name: 'Ana', email: 'ana@vertice.test' }

  it('accepts a client without a CPF', () => {
    const parsed = schema.parse(body)
    expect(parsed.cpf).toBeUndefined()
  })

  it('accepts an empty CPF', () => {
    expect(schema.parse({ ...body, cpf: '' }).cpf).toBe('')
  })

  it('passes a CPF through when given', () => {
    expect(schema.parse({ ...body, cpf: '52998224725' }).cpf).toBe('52998224725')
  })

  it('marks the CPF field optional', () => {
    expect(schema.shape.cpf.isOptional()).toBe(true)
  })

  it('still requires a name and an email', () => {
    expect(() => schema.parse({ cpf: '52998224725' })).toThrow()
  })
})
