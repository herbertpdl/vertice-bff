import { ValidationError } from './errors.js'

export function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`Invalid id: ${raw}`)
  }
  return id
}

/** For a query id a Zod schema parsed as optional but the route needs: absent is a 400. */
export function requireQueryId(id: number | undefined, name: string): number {
  if (id === undefined) throw new ValidationError(`${name} is required`)
  return id
}
