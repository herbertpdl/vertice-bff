import { describe, expect, it } from 'vitest'
import { clientCreateSchema, clientUpdateSchema } from './schemas.js'

// vertice-api #65 (P1-04, D1): a CPF is optional for a CLIENT. On create, absent or '' means none
// (stored as NULL); on update, absent keeps the stored CPF (the route sends it back) and null
// removes it. A CPF that is set is still validated upstream; the BFF's mask never is one.
describe.each([
  ['clientCreateSchema', clientCreateSchema],
  ['clientUpdateSchema', clientUpdateSchema],
] as const)('%s CPF', (_name, schema) => {
  const body = { name: 'Ana', email: 'ana@vertice.test' }

  it('accepts a client without a CPF', () => {
    const parsed = schema.parse(body)
    expect(parsed.cpf).toBeUndefined()
  })

  it('accepts an empty CPF, which means none', () => {
    expect(schema.parse({ ...body, cpf: '' }).cpf).toBe('')
  })

  it.each(['5299822472', '529982247250', '529.982.247-25', '52998224726', '11111111111', 'abcdefghijk'])(
    'rejects the malformed or invalid CPF %s',
    (cpf) => {
      expect(() => schema.parse({ ...body, cpf })).toThrow(/CPF must be 11 digits/)
    },
  )

  it('trims and lower-cases the email, and caps the name and email', () => {
    expect(schema.parse({ ...body, email: '  Ana@Vertice.TEST ' }).email).toBe('ana@vertice.test')
    expect(() => schema.parse({ ...body, name: '   ' })).toThrow()
    expect(() => schema.parse({ ...body, name: 'a'.repeat(256) })).toThrow()
    expect(() => schema.parse({ ...body, email: `${'a'.repeat(250)}@vertice.test` })).toThrow()
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

  it.each(['***.***.***-25', '***.***.***-**'])('rejects the masked CPF %s', (cpf) => {
    expect(() => schema.parse({ ...body, cpf })).toThrow(/masked/)
  })
})

describe('CPF null', () => {
  const body = { name: 'Ana', email: 'ana@vertice.test', cpf: null }

  it('is the explicit "remove the CPF" on update', () => {
    expect(clientUpdateSchema.parse(body).cpf).toBeNull()
  })

  it('is refused on create, where omitting it already means none', () => {
    expect(() => clientCreateSchema.parse(body)).toThrow()
  })
})
