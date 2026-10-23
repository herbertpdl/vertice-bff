import { describe, expect, it } from 'vitest'
import { submitFeedbackSchema } from './schemas.js'

describe('submitFeedbackSchema', () => {
  it('trims the text, accepts up to 2000 characters, and makes it optional', () => {
    expect(submitFeedbackSchema.parse({ rating: 'HARD', text: '  Pesado  ' }).text).toBe('Pesado')
    expect(submitFeedbackSchema.parse({ rating: 'HARD', text: 'a'.repeat(2000) }).text).toHaveLength(2000)
    expect(submitFeedbackSchema.parse({ rating: 'VERY_EASY' }).text).toBe('')
    expect(submitFeedbackSchema.parse({ rating: 'EASY', text: '   ' }).text).toBe('')
  })

  it('refuses a missing or unknown rating and an oversized text', () => {
    expect(() => submitFeedbackSchema.parse({ text: 'Pesado' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'MEDIUM' })).toThrow()
    expect(() => submitFeedbackSchema.parse({ rating: 'HARD', text: 'a'.repeat(2001) })).toThrow()
    expect(() => submitFeedbackSchema.parse({ text: 'a'.repeat(10 * 1024) })).toThrow()
  })
})
