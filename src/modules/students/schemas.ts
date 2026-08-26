import { z } from 'zod'

export const studentCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  cpf: z.string().optional(),
})

export const studentUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  cpf: z.string().optional(),
})
