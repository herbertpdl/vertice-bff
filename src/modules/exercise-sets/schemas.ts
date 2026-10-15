import { z } from 'zod'
import {
  boundedText,
  durationSeconds,
  LOAD_PERCENTAGE_PATTERN,
  loadPercentageMessage,
  optionalDecimal,
  orderNumber,
  repsCount,
  restSeconds,
  WEIGHT_PATTERN,
  weightMessage,
} from '../../lib/validation.js'

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

// Bounds mirror vertice-api's (its PR #70): numbers are capped, `weight` fits NUMERIC(6,2),
// `loadPercentage` NUMERIC(5,2), notes VARCHAR(255). Shared with the nested entries in `workouts`.
export const weightSchema = optionalDecimal(WEIGHT_PATTERN, weightMessage)
export const loadPercentageSchema = optionalDecimal(LOAD_PERCENTAGE_PATTERN, loadPercentageMessage)

export const exerciseSetInputSchema = z.object({
  setNumber: orderNumber,
  reps: repsCount.optional(),
  durationSeconds: durationSeconds.optional(),
  weight: weightSchema,
  loadPercentage: loadPercentageSchema,
  strategy: setStrategySchema,
  restSeconds: restSeconds.optional(),
  notes: boundedText(255).optional(),
})
