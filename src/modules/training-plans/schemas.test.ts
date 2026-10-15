import { describe, expect, it } from 'vitest'
import { trainingPlanInputSchema, trainingPlanListQuerySchema, trainingPlanUpdateSchema } from './schemas.js'

const plan = {
  name: 'Hipertrofia',
  clientId: 20,
  startDate: '2026-11-01',
  endDate: '2027-01-31',
  level: 'BEGINNER',
}

describe.each([
  ['trainingPlanInputSchema', trainingPlanInputSchema, plan],
  ['trainingPlanUpdateSchema', trainingPlanUpdateSchema, plan],
] as const)('%s', (_name, schema, base) => {
  it('accepts an end on or after the start', () => {
    expect(schema.parse(base).description).toBe('')
    expect(schema.parse({ ...base, endDate: base.startDate }).endDate).toBe(base.startDate)
  })

  it('refuses an end before the start, on endDate', () => {
    const result = schema.safeParse({ ...base, endDate: '2026-10-31' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.flatten().fieldErrors.endDate).toBeDefined()
  })

  it('refuses a date that does not exist', () => {
    expect(() => schema.parse({ ...base, endDate: '2027-02-30' })).toThrow()
  })

  it('bounds the name (255, not blank) and the description (255)', () => {
    expect(() => schema.parse({ ...base, name: '  ' })).toThrow()
    expect(() => schema.parse({ ...base, name: 'a'.repeat(256) })).toThrow()
    expect(() => schema.parse({ ...base, description: 'd'.repeat(256) })).toThrow()
    expect(schema.parse({ ...base, description: 'd'.repeat(255) }).description).toHaveLength(255)
  })
})

describe('trainingPlanUpdateSchema', () => {
  it('drops a clientId', () => {
    expect(trainingPlanUpdateSchema.parse(plan)).not.toHaveProperty('clientId')
  })
})

describe('trainingPlanListQuerySchema', () => {
  it('reads clientId, and refuses a non-id', () => {
    expect(trainingPlanListQuerySchema.parse({ clientId: '20' }).clientId).toBe(20)
    expect(trainingPlanListQuerySchema.parse({}).clientId).toBeUndefined()
    expect(() => trainingPlanListQuerySchema.parse({ clientId: 'abc' })).toThrow()
  })
})
