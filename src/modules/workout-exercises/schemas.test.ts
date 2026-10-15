import { describe, expect, it } from 'vitest'
import { workoutExerciseCreateSchema, workoutExerciseUpdateSchema } from './schemas.js'

describe.each([
  ['workoutExerciseCreateSchema', workoutExerciseCreateSchema, { exerciseId: 3 }],
  ['workoutExerciseUpdateSchema', workoutExerciseUpdateSchema, {}],
] as const)('%s', (_name, schema, base) => {
  it('takes an order from 1 to 1000 (the API refuses 0)', () => {
    expect(schema.parse({ ...base, order: 1 }).order).toBe(1)
    expect(schema.parse({ ...base, order: 1000 }).order).toBe(1000)
    expect(() => schema.parse({ ...base, order: 0 })).toThrow()
    expect(() => schema.parse({ ...base, order: 1001 })).toThrow()
    expect(() => schema.parse({ ...base, order: 1.5 })).toThrow()
  })

  it('bounds the rest between sets (0..3600) and the notes (255)', () => {
    expect(schema.parse({ ...base, order: 1 }).restSecondsBetweenSets).toBe(0)
    expect(() => schema.parse({ ...base, order: 1, restSecondsBetweenSets: 3601 })).toThrow()
    expect(() => schema.parse({ ...base, order: 1, notes: 'n'.repeat(256) })).toThrow()
    expect(schema.parse({ ...base, order: 1, notes: 'n'.repeat(255) }).notes).toHaveLength(255)
  })
})
