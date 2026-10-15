import { describe, expect, it } from 'vitest'
import { isoDateSchema, optionalIdQuery, requiredText } from './validation.js'

describe('requiredText', () => {
  const schema = requiredText(5)

  it('trims, and refuses blank text', () => {
    expect(schema.parse('  ab ')).toBe('ab')
    expect(() => schema.parse('   ')).toThrow()
    expect(() => schema.parse('')).toThrow()
  })

  it('bounds the raw value, as the API does, and counts UTF-16 units', () => {
    expect(schema.parse('abcde')).toBe('abcde')
    expect(() => schema.parse('abcdef')).toThrow()
    expect(() => schema.parse(' abcde ')).toThrow()
    expect(() => requiredText(2).parse('😀😀')).toThrow() // 4 UTF-16 units
  })
})

describe('isoDateSchema', () => {
  it('accepts a calendar date and refuses shapes and impossible dates', () => {
    expect(isoDateSchema.parse('2028-02-29')).toBe('2028-02-29')
    for (const bad of ['2027-02-29', '2026-13-01', '2026-1-1', '26-01-01', '2026-01-01T00:00', '']) {
      expect(() => isoDateSchema.parse(bad), bad).toThrow()
    }
  })
})

describe('optionalIdQuery', () => {
  it('reads a positive integer, and treats absent or empty as no value', () => {
    expect(optionalIdQuery.parse('12')).toBe(12)
    expect(optionalIdQuery.parse(undefined)).toBeUndefined()
    expect(optionalIdQuery.parse('')).toBeUndefined()
  })

  it.each(['0', '-1', '1.5', 'abc', '0x10', '1e3', ' 1', '12345678901234567890'])('refuses %s', (raw) => {
    expect(() => optionalIdQuery.parse(raw)).toThrow()
  })
})
