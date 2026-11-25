import { z } from 'zod'
import { cpfInputSchema, emailSchema } from '../auth/schemas.js'
import { requiredText, utf16String } from '../../lib/validation.js'

export const clientCreateSchema = z.object({
  name: requiredText(255),
  email: emailSchema,
  // No password: the client chooses their own through the setup token the
  // create response returns (see clients/service.ts createClient()). A
  // `password` key in the body is stripped, never sent upstream.
  // Optional for a CLIENT (vertice-api #65): absent or '' creates the client without one.
  cpf: cpfInputSchema.optional(),
}).meta({ id: 'CreateClientRequest' })

/**
 * `PATCH /clients/:id`. `cpf`: omitted keeps the stored CPF (the route reads it and sends it back,
 * since vertice-api's `UpdateUser` replaces every field); a string sets it; `null` removes it.
 */
export const clientUpdateSchema = z.object({
  name: requiredText(255),
  email: emailSchema,
  cpf: cpfInputSchema.nullable().optional(),
}).meta({ id: 'UpdateClientRequest' })

/**
 * `GET /clients/:id` query. `reveal=cpf` returns the CPF in full instead of masked; nothing else
 * is accepted, so a typo is a 400 rather than a silently masked answer.
 */
export const clientDetailQuerySchema = z
  .object({
    reveal: z.literal('cpf').optional(),
  })
  .strict()

/**
 * The longest anamnese, in UTF-16 units (vertice-api's bound, client-anamnese R10). 5,000 units
 * are never more than 5,000 code points, vertice-ai's bound (`AI_MAX_ANAMNESE`).
 */
export const ANAMNESE_MAX_LENGTH = 5_000

/**
 * `PUT /clients/:id/anamnese`. The text as written: required, empty allowed, never trimmed. The
 * BFF has no "blank" rule of its own (spec A3): vertice-api decides, clears a blank text and
 * answers the empty state.
 */
export const clientAnamneseSaveSchema = z
  .object({
    text: utf16String(ANAMNESE_MAX_LENGTH).describe(
      'The whole anamnese, stored as written (not trimmed). At most 5,000 UTF-16 units (a character outside ' +
        'the BMP counts two). A blank text clears it.',
    ),
  })
  .strict()
  .meta({ id: 'SaveClientAnamneseRequest' })
