import { z } from 'zod'

export const setStrategySchema = z.enum([
  'STRAIGHT',
  'WARM_UP',
  'BACKOFF',
  'DROPSET',
  'REST_PAUSE',
  'CLUSTER',
  'AMRAP',
  'ISOMETRIC_HOLD',
  'FAILURE',
])

export const exerciseSetInputSchema = z.object({
  setNumber: z.number().int().positive(),
  reps: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  weight: z.string().optional(),
  loadPercentage: z.string().optional(),
  strategy: setStrategySchema,
  restSeconds: z.number().int().min(0).optional(),
  notes: z.string().optional(),
})
