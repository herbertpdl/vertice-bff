import { describe, expect, it } from 'vitest'
import { cloneWorkoutSchema, replaceWorkoutExercisesSchema, workoutCreateSchema, workoutListQuerySchema } from './schemas.js'

const set = { reps: 10, weight: '60.0', strategy: 'STRAIGHT' as const }
const exercise = (sets: unknown[] = [set]) => ({ exerciseId: 12, restSecondsBetweenSets: 90, sets })

describe('workoutCreateSchema', () => {
  it('accepts a body with no exercises and defaults it to []', () => {
    const parsed = workoutCreateSchema.parse({ name: 'Treino A', dayOfWeek: 'MONDAY' })
    expect(parsed.exercises).toEqual([])
  })

  it('accepts 20 exercises with 10 sets each', () => {
    const body = {
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: Array.from({ length: 20 }, () => exercise(Array.from({ length: 10 }, () => set))),
    }
    const parsed = workoutCreateSchema.parse(body)
    expect(parsed.exercises).toHaveLength(20)
    expect(parsed.exercises[0]!.sets).toHaveLength(10)
  })

  it('rejects 21 exercises', () => {
    const body = {
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: Array.from({ length: 21 }, () => exercise()),
    }
    expect(() => workoutCreateSchema.parse(body)).toThrow()
  })

  it('rejects 11 sets on one exercise', () => {
    const body = {
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: [exercise(Array.from({ length: 11 }, () => set))],
    }
    expect(() => workoutCreateSchema.parse(body)).toThrow()
  })

  it('accepts a set entry with no strategy and leaves it undefined', () => {
    const body = {
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: [exercise([{ reps: 8 }])],
    }
    const parsed = workoutCreateSchema.parse(body)
    expect(parsed.exercises[0]!.sets[0]!.strategy).toBeUndefined()
  })

  it('defaults an exercise entry with no sets to []', () => {
    const parsed = workoutCreateSchema.parse({
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: [{ exerciseId: 12 }],
    })
    expect(parsed.exercises[0]!.sets).toEqual([])
  })

  it('rejects a negative reps', () => {
    const body = {
      name: 'Treino A',
      dayOfWeek: 'MONDAY',
      exercises: [exercise([{ reps: -1 }])],
    }
    expect(() => workoutCreateSchema.parse(body)).toThrow()
  })

  it('still requires name and dayOfWeek', () => {
    expect(() => workoutCreateSchema.parse({ dayOfWeek: 'MONDAY', exercises: [] })).toThrow()
    expect(() => workoutCreateSchema.parse({ name: 'Treino A', exercises: [] })).toThrow()
  })
})

describe('replaceWorkoutExercisesSchema', () => {
  it('rejects a body without exercises', () => {
    expect(() => replaceWorkoutExercisesSchema.parse({})).toThrow()
  })

  it('accepts an empty exercises list', () => {
    expect(replaceWorkoutExercisesSchema.parse({ exercises: [] })).toEqual({ exercises: [] })
  })

  it('rejects 21 exercises', () => {
    const body = { exercises: Array.from({ length: 21 }, () => exercise()) }
    expect(() => replaceWorkoutExercisesSchema.parse(body)).toThrow()
  })
})

describe('nested entry bounds', () => {
  const body = (entry: unknown) => ({ name: 'Treino A', dayOfWeek: 'MONDAY', exercises: [entry] })

  it('accepts a set at every upper bound', () => {
    const entry = exercise([
      { reps: 1000, durationSeconds: 86_400, restSeconds: 3600, weight: '9999.99', loadPercentage: '999.99', notes: 'n'.repeat(255) },
    ])
    expect(workoutCreateSchema.parse(body({ ...entry, notes: 'n'.repeat(255) })).exercises).toHaveLength(1)
  })

  it.each([
    ['reps 1001', { reps: 1001 }],
    ['durationSeconds 86401', { durationSeconds: 86_401 }],
    ['restSeconds 3601', { restSeconds: 3601 }],
    ['a 5-digit weight', { weight: '10000' }],
    ['a 3-decimal load percentage', { loadPercentage: '1.234' }],
    ['set notes of 256', { notes: 'n'.repeat(256) }],
  ])('refuses a set with %s', (_why, patch) => {
    expect(() => workoutCreateSchema.parse(body(exercise([patch])))).toThrow()
  })

  it('refuses exercise notes over 255 and rest over 3600', () => {
    expect(() => workoutCreateSchema.parse(body({ ...exercise(), notes: 'n'.repeat(256) }))).toThrow()
    expect(() => workoutCreateSchema.parse(body({ ...exercise(), restSecondsBetweenSets: 3601 }))).toThrow()
  })

  it('refuses a blank or oversized workout name', () => {
    expect(() => workoutCreateSchema.parse({ name: '  ', dayOfWeek: 'MONDAY' })).toThrow()
    expect(() => workoutCreateSchema.parse({ name: 'a'.repeat(256), dayOfWeek: 'MONDAY' })).toThrow()
    expect(() => cloneWorkoutSchema.parse({ targetTrainingPlanId: 1, name: ' ', dayOfWeek: 'MONDAY' })).toThrow()
  })

  it('applies the same caps on replace', () => {
    expect(() => replaceWorkoutExercisesSchema.parse({ exercises: [exercise([{ reps: 1001 }])] })).toThrow()
  })
})

describe('workoutListQuerySchema', () => {
  it('only takes recent=true', () => {
    expect(workoutListQuerySchema.parse({ recent: 'true' })).toEqual({ recent: 'true' })
    expect(() => workoutListQuerySchema.parse({})).toThrow(/recent=true/)
    expect(() => workoutListQuerySchema.parse({ recent: 'false' })).toThrow()
  })
})
