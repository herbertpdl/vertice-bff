import { describe, expect, it } from 'vitest'
import { MAX_HISTORY_CHARACTERS, workoutChatRequestSchema } from './schemas.js'

const base = { trainingPlanId: 1, workout: { exercises: [] }, history: [], message: 'Oi' }
const entry = (key: string, sets = 1) => ({ key, exerciseId: 1, sets: Array.from({ length: sets }, () => ({ reps: 10 })) })
const ok = (body: unknown) => workoutChatRequestSchema.safeParse(body).success

describe('workoutChatRequestSchema', () => {
  it('accepts a 2,000-character message and refuses 2,001 (UTF-16 units) or a blank one', () => {
    expect(ok({ ...base, message: 'a'.repeat(2000) })).toBe(true)
    expect(ok({ ...base, message: 'a'.repeat(2001) })).toBe(false)
    expect(ok({ ...base, message: '😀'.repeat(1001) })).toBe(false)
    expect(ok({ ...base, message: '   ' })).toBe(false)
  })

  it('caps the history at 20 turns and 40,000 characters in total', () => {
    const turn = (text: string) => ({ role: 'user', text })
    expect(ok({ ...base, history: Array.from({ length: 20 }, () => turn('x')) })).toBe(true)
    expect(ok({ ...base, history: Array.from({ length: 21 }, () => turn('x')) })).toBe(false)
    expect(ok({ ...base, history: [turn('x'.repeat(MAX_HISTORY_CHARACTERS))] })).toBe(true)
    expect(ok({ ...base, history: [turn('x'.repeat(20_000)), turn('x'.repeat(20_001))] })).toBe(false)
    expect(ok({ ...base, history: [{ role: 'system', text: 'x' }] })).toBe(false)
    expect(ok({ ...base, history: [turn('')] })).toBe(false)
  })

  it('takes the workout at the 20/10 caps and refuses 21 exercises or 11 sets', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => entry(`e${i}`, 10))
    expect(ok({ ...base, workout: { exercises: twenty } })).toBe(true)
    expect(ok({ ...base, workout: { exercises: [...twenty, entry('e20')] } })).toBe(false)
    expect(ok({ ...base, workout: { exercises: [entry('e1', 11)] } })).toBe(false)
  })

  it('requires a unique, well-formed key on each on-screen exercise', () => {
    expect(ok({ ...base, workout: { exercises: [entry('a'), entry('a')] } })).toBe(false)
    expect(ok({ ...base, workout: { exercises: [{ exerciseId: 1 }] } })).toBe(false)
    expect(ok({ ...base, workout: { exercises: [entry('has space')] } })).toBe(false)
    expect(ok({ ...base, workout: { exercises: [entry('x'.repeat(65))] } })).toBe(false)
  })

  it('strips a name or weekday sent with the workout (the assistant never changes them)', () => {
    const parsed = workoutChatRequestSchema.parse({ ...base, workout: { name: 'X', dayOfWeek: 'MONDAY', exercises: [] } })
    expect(parsed.workout).toEqual({ exercises: [] })
  })

  it('makes workoutId optional and history default to empty', () => {
    const parsed = workoutChatRequestSchema.parse({ trainingPlanId: 1, workout: { exercises: [] }, message: 'Oi' })
    expect(parsed.workoutId).toBeUndefined()
    expect(parsed.history).toEqual([])
    expect(ok({ ...base, workoutId: 0 })).toBe(false)
  })
})
