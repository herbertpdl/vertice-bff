import { z } from 'zod'

export const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
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
