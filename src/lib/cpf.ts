/**
 * Masks a CPF for display, keeping only its two check digits: `***.***.***-25`. CPF is identity
 * data (LGPD), so the BFF never returns one in full unless the trainer asks for it
 * (`GET /clients/:id?reveal=cpf`). An empty CPF stays empty; anything that isn't 11 digits gives
 * no digits away at all.
 */
export function maskCpf(cpf: string): string {
  if (!cpf) return ''
  const digits = cpf.replace(/\D/g, '')
  return `***.***.***-${digits.length === 11 ? digits.slice(-2) : '**'}`
}

/**
 * vertice-api's `@Cpf` rule: exactly 11 digits (no punctuation), not all the same digit, and both
 * check digits valid. The BFF checks it so a bad CPF is a field-level 400 here instead of an
 * upstream message; vertice-api stays authoritative.
 */
export function isValidCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf)) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false
  const digits = [...cpf].map(Number)
  const check = (length: number) => {
    let sum = 0
    for (let i = 0; i < length; i++) sum += digits[i]! * (length + 1 - i)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return check(9) === digits[9] && check(10) === digits[10]
}
