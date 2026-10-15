import { describe, expect, it } from 'vitest'
import { isValidCpf, maskCpf } from './cpf.js'

describe('isValidCpf', () => {
  it.each(['52998224725', '11144477735', '00000000191'])('accepts %s', (cpf) => {
    expect(isValidCpf(cpf)).toBe(true)
  })

  it.each([
    ['a wrong first check digit', '52998224715'],
    ['a wrong second check digit', '52998224726'],
    ['the same digit repeated', '11111111111'],
    ['punctuation', '529.982.247-25'],
    ['too few digits', '5299822472'],
    ['too many digits', '529982247250'],
    ['letters', '5299822472a'],
    ['empty', ''],
  ])('rejects %s', (_why, cpf) => {
    expect(isValidCpf(cpf)).toBe(false)
  })
})

describe('maskCpf', () => {
  it('keeps only the check digits', () => {
    expect(maskCpf('52998224725')).toBe('***.***.***-25')
  })
})
