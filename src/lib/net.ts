import { ValidationError } from './errors.js'

export function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`Invalid id: ${raw}`)
  }
  return id
}

/** Like `parseId`, for a query parameter that must be present: missing, empty or non-numeric is 400. */
export function parseRequiredId(raw: string | undefined, name: string): number {
  if (raw === undefined || raw === '') throw new ValidationError(`${name} is required`)
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`Invalid ${name}: ${raw}`)
  return id
}
