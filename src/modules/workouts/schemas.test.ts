import { describe, expect, it } from 'vitest'
import { replaceWorkoutExercisesSchema, workoutCreateSchema } from './schemas.js'

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
