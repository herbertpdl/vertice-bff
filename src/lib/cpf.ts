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
