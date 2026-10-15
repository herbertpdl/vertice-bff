import { z } from 'zod'
import { emailSchema } from '../auth/schemas.js'

/**
 * A CPF as the client sends it. The BFF's own mask (`***.***.***-25`, see `lib/cpf.ts`) is refused:
 * echoing a masked detail back would otherwise reach vertice-api as the new CPF.
 */
const cpfInputSchema = z.string().refine((cpf) => !cpf.includes('*'), 'Send the full CPF, not the masked one')

export const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  // No password: the client chooses their own through the setup token the
  // create response returns (see clients/service.ts createClient()). A
  // `password` key in the body is stripped, never sent upstream.
  // Optional for a CLIENT (vertice-api #65): absent or '' creates the client without one.
  cpf: cpfInputSchema.optional(),
})

/**
 * `PATCH /clients/:id`. `cpf`: omitted keeps the stored CPF (the route reads it and sends it back,
 * since vertice-api's `UpdateUser` replaces every field); a string sets it; `null` removes it.
 */
export const clientUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  cpf: cpfInputSchema.nullable().optional(),
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
