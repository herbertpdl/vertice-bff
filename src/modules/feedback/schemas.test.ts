import { describe, expect, it } from 'vitest'
import { submitFeedbackSchema } from './schemas.js'

describe('submitFeedbackSchema', () => {
  it('trims the text, accepts up to 2000 characters, and makes it optional', () => {
    expect(submitFeedbackSchema.parse({ rating: 'HARD', text: '  Pesado  ' }).text).toBe('Pesado')
    expect(submitFeedbackSchema.parse({ rating: 'HARD', text: 'a'.repeat(2000) }).text).toHaveLength(2000)
    expect(submitFeedbackSchema.parse({ rating: 'VERY_EASY' }).text).toBe('')
    expect(submitFeedbackSchema.parse({ rating: 'EASY', text: '   ' }).text).toBe('')
  })

  it('takes an optional idempotency key of 1-64 characters of [A-Za-z0-9_-]', () => {
    expect(submitFeedbackSchema.parse({ rating: 'HARD' }).clientKey).toBeUndefined()
    expect(submitFeedbackSchema.parse({ rating: 'HARD', clientKey: '1729699200000-3' }).clientKey).toBe('1729699200000-3')
    expect(() => submitFeedbackSchema.parse({ rating: 'HARD', clientKey: '' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'HARD', clientKey: 'a b' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'HARD', clientKey: 'a'.repeat(65) })).toThrow()
  })

  it('refuses a missing or unknown rating and an oversized text', () => {
    expect(() => submitFeedbackSchema.parse({ text: 'Pesado' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'MEDIUM' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'HARD', text: 'a'.repeat(2001) })).toThrow()
    expect(() => submitFeedbackSchema.parse({ text: 'a'.repeat(10 * 1024) })).toThrow()
  })
})
