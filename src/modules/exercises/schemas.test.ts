import { describe, expect, it } from 'vitest'
import { exerciseInputSchema, exerciseListQuerySchema } from './schemas.js'

describe('exerciseInputSchema', () => {
  const base = { name: 'Remada curvada' }

  it('rejects an empty muscleGroupIds', () => {
    expect(() => exerciseInputSchema.parse({ ...base, muscleGroupIds: [] })).toThrow()
  })

  it('rejects a body without muscleGroupIds even when it carries the retired muscleGroup field', () => {
    expect(() => exerciseInputSchema.parse({ ...base, muscleGroup: 'CHEST' })).toThrow()
  })

  it('accepts a single muscle group', () => {
    expect(exerciseInputSchema.parse({ ...base, muscleGroupIds: [2] }).muscleGroupIds).toEqual([2])
  })

  it('accepts several muscle groups and de-duplicates them keeping first occurrence', () => {
    expect(exerciseInputSchema.parse({ ...base, muscleGroupIds: [3, 1, 3, 2] }).muscleGroupIds).toEqual([3, 1, 2])
  })

  it('rejects a non-integer or non-positive muscle group id', () => {
    for (const ids of [[0], [-1], [1.5], ['1']]) {
      expect(() => exerciseInputSchema.parse({ ...base, muscleGroupIds: ids })).toThrow()
    }
  })

  it('keeps videoUrl optional-or-blank and rejects a non-URL', () => {
    const body = { ...base, muscleGroupIds: [1] }
    expect(exerciseInputSchema.parse(body).videoUrl).toBeUndefined()
    expect(exerciseInputSchema.parse({ ...body, videoUrl: '' }).videoUrl).toBe('')
    expect(exerciseInputSchema.parse({ ...body, videoUrl: 'https://x.test/v' }).videoUrl).toBe('https://x.test/v')
    expect(() => exerciseInputSchema.parse({ ...body, videoUrl: 'not a url' })).toThrow()
  })

  it('rejects name longer than 255, description longer than 255, videoUrl longer than 500', () => {
    const body = { ...base, muscleGroupIds: [1] }
    expect(() => exerciseInputSchema.parse({ ...body, name: 'a'.repeat(256) })).toThrow()
    expect(() => exerciseInputSchema.parse({ ...body, description: 'a'.repeat(256) })).toThrow()
    expect(() =>
      exerciseInputSchema.parse({ ...body, videoUrl: `https://x.test/${'a'.repeat(500)}` }),
    ).toThrow()
    expect(() =>
      exerciseInputSchema.parse({ name: 'a'.repeat(255), description: 'a'.repeat(255), muscleGroupIds: [1] }),
    ).not.toThrow()
  })

  it("defaults description to ''", () => {
    expect(exerciseInputSchema.parse({ ...base, muscleGroupIds: [1] }).description).toBe('')
  })
})

describe('exerciseListQuerySchema', () => {
  it('treats empty muscleGroupId and q as absent', () => {
    expect(exerciseListQuerySchema.parse({ muscleGroupId: '', q: '' })).toEqual({})
    expect(exerciseListQuerySchema.parse({})).toEqual({})
  })

  it('coerces muscleGroupId to a positive integer', () => {
    expect(exerciseListQuerySchema.parse({ muscleGroupId: '12' })).toEqual({ muscleGroupId: 12 })
    for (const muscleGroupId of ['0', '-1', 'abc', '1.5', ['1', '2']]) {
      expect(() => exerciseListQuerySchema.parse({ muscleGroupId })).toThrow()
    }
  })

  it('trims q and rejects more than 100 characters', () => {
    expect(exerciseListQuerySchema.parse({ q: '  supino ' })).toEqual({ q: 'supino' })
    expect(exerciseListQuerySchema.parse({ q: 'a'.repeat(100) })).toEqual({ q: 'a'.repeat(100) })
    expect(() => exerciseListQuerySchema.parse({ q: 'a'.repeat(101) })).toThrow()
    expect(exerciseListQuerySchema.parse({ q: '   ' })).toEqual({})
    expect(() => exerciseListQuerySchema.parse({ q: ['a', 'b'] })).toThrow()
  })
})
