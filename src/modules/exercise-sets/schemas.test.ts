import { describe, expect, it } from 'vitest'
import { exerciseSetInputSchema } from './schemas.js'

const set = { setNumber: 1, strategy: 'STRAIGHT' }

describe('exerciseSetInputSchema', () => {
  it('accepts a set at every upper bound', () => {
    const parsed = exerciseSetInputSchema.parse({
      setNumber: 1000,
      reps: 1000,
      durationSeconds: 86_400,
      restSeconds: 3600,
      weight: '9999.99',
      loadPercentage: '999.99',
      strategy: 'STRAIGHT',
      notes: 'n'.repeat(255),
    })
    expect(parsed.setNumber).toBe(1000)
  })

  it.each([
    ['setNumber 0', { setNumber: 0 }],
    ['setNumber 1001', { setNumber: 1001 }],
    ['reps 1001', { reps: 1001 }],
    ['reps -1', { reps: -1 }],
    ['durationSeconds 86401', { durationSeconds: 86_401 }],
    ['restSeconds 3601', { restSeconds: 3601 }],
    ['notes of 256', { notes: 'n'.repeat(256) }],
    ['weight 5 integer digits', { weight: '10000' }],
    ['weight 3 decimals', { weight: '1.234' }],
    ['weight negative', { weight: '-1' }],
    ['weight with a comma', { weight: '1,5' }],
    ['weight in exponent form', { weight: '1e2' }],
    ['loadPercentage 4 integer digits', { loadPercentage: '1000' }],
    ['loadPercentage 3 decimals', { loadPercentage: '80.123' }],
  ])('refuses %s', (_why, patch) => {
    expect(() => exerciseSetInputSchema.parse({ ...set, ...patch })).toThrow()
  })

  it('treats an empty weight or load percentage as unset', () => {
    const parsed = exerciseSetInputSchema.parse({ ...set, weight: '', loadPercentage: '' })
    expect(parsed.weight).toBe('')
    expect(parsed.loadPercentage).toBe('')
  })

  it.each(['0', '60', '60.5', '60.25', '0.5'])('accepts the weight %s', (weight) => {
    expect(exerciseSetInputSchema.parse({ ...set, weight }).weight).toBe(weight)
  })
})
