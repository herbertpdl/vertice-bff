import { z } from 'zod'

export const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // Optional: the design's client creation flow is invite-based (no password
  // field in the UI). When omitted, the service generates a random one — see
  // clients/service.ts createClient().
  password: z.string().min(6).optional(),
  cpf: z.string().optional(),
})

export const clientUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  cpf: z.string().optional(),
})
