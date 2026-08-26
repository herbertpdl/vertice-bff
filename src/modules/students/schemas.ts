import { z } from 'zod'

export const studentCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // Optional: the design's student creation flow is invite-based (no password
  // field in the UI). When omitted, the service generates a random one — see
  // students/service.ts createStudent().
  password: z.string().min(6).optional(),
  cpf: z.string().optional(),
})

export const studentUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  cpf: z.string().optional(),
})
