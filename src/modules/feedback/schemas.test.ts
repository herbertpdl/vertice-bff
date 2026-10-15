import { describe, expect, it } from 'vitest'
import { submitFeedbackSchema } from './schemas.js'

describe('submitFeedbackSchema', () => {
  it('trims the text and accepts up to 2000 characters', () => {
    expect(submitFeedbackSchema.parse({ text: '  Pesado  ' }).text).toBe('Pesado')
    expect(submitFeedbackSchema.parse({ text: 'a'.repeat(2000) }).text).toHaveLength(2000)
  })

  it('refuses blank, missing and oversized text', () => {
    expect(() => submitFeedbackSchema.parse({ text: '   ' })).toThrow()
    expect(() => submitFeedbackSchema.parse({})).toThrow()
    expect(() => submitFeedbackSchema.parse({ text: 'a'.repeat(2001) })).toThrow()
    expect(() => submitFeedbackSchema.parse({ text: 'a'.repeat(10 * 1024) })).toThrow()
  })
})
