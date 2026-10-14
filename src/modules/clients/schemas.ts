import { z } from 'zod'
import { emailSchema } from '../auth/schemas.js'

export const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  // No password: the client chooses their own through the setup token the
  // create response returns (see clients/service.ts createClient()). A
  // `password` key in the body is stripped, never sent upstream.
  cpf: z.string().optional(),
})

export const clientUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  cpf: z.string().optional(),
})

/**
 * `GET /clients/:id` query. `reveal=cpf` returns the CPF in full instead of masked; nothing else
 * is accepted, so a typo is a 400 rather than a silently masked answer.
 */
export const clientDetailQuerySchema = z
  .object({
    reveal: z.literal('cpf').optional(),
  })
  .strict()
