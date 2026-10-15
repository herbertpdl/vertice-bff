import { z } from 'zod'
import { boundedText, orderNumber, restSeconds } from '../../lib/validation.js'

// Bounds mirror vertice-api's (its PR #70): `order` 1..1000 (the web sends `i + 1`), rest 0..3600,
// notes at most 255.
export const workoutExerciseCreateSchema = z.object({
  exerciseId: z.number().int().positive(),
  order: orderNumber,
  restSecondsBetweenSets: restSeconds.default(0),
  notes: boundedText(255).default(''),
}).meta({ id: 'CreateWorkoutExerciseRequest' })

export const workoutExerciseUpdateSchema = z.object({
  order: orderNumber,
  restSecondsBetweenSets: restSeconds.default(0),
  notes: boundedText(255).default(''),
}).meta({ id: 'UpdateWorkoutExerciseRequest' })
