import { z } from 'zod'
import { loadPercentageSchema, setStrategySchema, weightSchema } from '../exercise-sets/schemas.js'
import {
  boundedText,
  durationSeconds,
  MAX_EXERCISES_PER_WORKOUT,
  MAX_SETS_PER_EXERCISE,
  repsCount,
  requiredText,
  restSeconds,
} from '../../lib/validation.js'

export const dayOfWeekSchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
])

/** `GET /workouts` query: only `?recent=true` exists (the clone picker); anything else is a 400. */
export const workoutListQuerySchema = z.object({
  recent: z.literal('true', { errorMap: () => ({ message: 'GET /workouts requires ?recent=true' }) }),
})

export const workoutInputSchema = z.object({
  name: requiredText(255),
  dayOfWeek: dayOfWeekSchema,
})

// Nested entries for create-with-exercises / replace-exercises. No `setNumber`
// and no `order`: list position is the order (vertice-api assigns both).
// `strategy` is deliberately optional and NOT defaulted here — an omitted value
// is forwarded unset so vertice-api applies its own default (STRAIGHT), keeping
// that rule in one place. The per-set `exerciseSetInputSchema` (where strategy
// is required) is untouched.
export const exerciseSetEntrySchema = z.object({
  reps: repsCount.optional(),
  durationSeconds: durationSeconds.optional(),
  weight: weightSchema,
  loadPercentage: loadPercentageSchema,
  strategy: setStrategySchema.optional(),
  restSeconds: restSeconds.optional(),
  notes: boundedText(255).optional(),
})

// Caps (20 exercises, 10 sets) mirror vertice-api's, purely to fail fast with
// a field-level Zod `details` object; the API is authoritative and rejects too.
export const workoutExerciseEntrySchema = z.object({
  exerciseId: z.number().int().positive(),
  restSecondsBetweenSets: restSeconds.optional(),
  notes: boundedText(255).optional(),
  sets: z.array(exerciseSetEntrySchema).max(MAX_SETS_PER_EXERCISE).default([]),
})

export const workoutCreateSchema = workoutInputSchema.extend({
  exercises: z.array(workoutExerciseEntrySchema).max(MAX_EXERCISES_PER_WORKOUT).default([]),
})

// `exercises` is required (may be `[]`, which empties the workout): a PUT with
// no list is more likely a bug than an intent to clear the workout.
export const replaceWorkoutExercisesSchema = z.object({
  exercises: z.array(workoutExerciseEntrySchema).max(MAX_EXERCISES_PER_WORKOUT),
})

export const cloneWorkoutSchema = z.object({
  targetTrainingPlanId: z.number().int().positive(),
  name: requiredText(255),
  dayOfWeek: dayOfWeekSchema,
})
