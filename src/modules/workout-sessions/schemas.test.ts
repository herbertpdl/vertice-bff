import { describe, expect, it } from 'vitest'
import { recordSetLogSchema, weekStartDateQuerySchema, workoutLogListQuerySchema } from './schemas.js'

describe('recordSetLogSchema', () => {
  const log = { exerciseSetId: 4, weight: '60.5', reps: 10 }

  it('accepts a log at the bounds', () => {
    expect(recordSetLogSchema.parse({ ...log, weight: '9999.99', reps: 1000 }).reps).toBe(1000)
    expect(recordSetLogSchema.parse({ ...log, reps: 0 }).reps).toBe(0)
  })

  it('accepts an empty weight: a set ticked without one', () => {
    expect(recordSetLogSchema.parse({ exerciseSetId: 1, weight: '', reps: 10 }).weight).toBe('')
  })

  it.each([
    ['a 5-digit weight', { weight: '10000' }],
    ['3 decimals', { weight: '1.234' }],
    ['a negative weight', { weight: '-5' }],
    ['reps 1001', { reps: 1001 }],
    ['negative reps', { reps: -1 }],
  ])('refuses %s', (_why, patch) => {
    expect(() => recordSetLogSchema.parse({ ...log, ...patch })).toThrow()
  })
})

describe('weekStartDateQuerySchema', () => {
  it('reads a date and a client id; both optional', () => {
    expect(weekStartDateQuerySchema.parse({})).toEqual({})
    expect(weekStartDateQuerySchema.parse({ weekStartDate: '2026-10-12', clientId: '3' })).toEqual({
      weekStartDate: '2026-10-12',
      clientId: 3,
    })
  })

  it.each(['2026-13-01', '12/10/2026', 'today', '2026-10-12T00:00:00Z'])('refuses the date %s', (weekStartDate) => {
    expect(() => weekStartDateQuerySchema.parse({ weekStartDate })).toThrow()
  })
})

describe('workoutLogListQuerySchema', () => {
  it('adds trainingPlanId and refuses a non-id', () => {
    expect(workoutLogListQuerySchema.parse({ trainingPlanId: '7' }).trainingPlanId).toBe(7)
    expect(() => workoutLogListQuerySchema.parse({ trainingPlanId: 'x' })).toThrow()
  })
})
