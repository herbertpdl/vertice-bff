import { ValidationError } from './errors.js'

export function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`Invalid id: ${raw}`)
  }
  return id
}
