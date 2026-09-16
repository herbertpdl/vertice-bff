import { z } from 'zod'
import { setStrategySchema } from '../exercise-sets/schemas.js'

export const dayOfWeekSchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
])

export const workoutInputSchema = z.object({
  name: z.string().min(1),
  dayOfWeek: dayOfWeekSchema,
})

// Nested entries for create-with-exercises / replace-exercises. No `setNumber`
// and no `order`: list position is the order (vertice-api assigns both).
// `strategy` is deliberately optional and NOT defaulted here — an omitted value
// is forwarded unset so vertice-api applies its own default (STRAIGHT), keeping
// that rule in one place. The per-set `exerciseSetInputSchema` (where strategy
// is required) is untouched.
export const exerciseSetEntrySchema = z.object({
  reps: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  weight: z.string().optional(),
  loadPercentage: z.string().optional(),
  strategy: setStrategySchema.optional(),
  restSeconds: z.number().int().min(0).optional(),
  notes: z.string().optional(),
})

// Caps (20 exercises, 10 sets) mirror vertice-api's, purely to fail fast with
// a field-level Zod `details` object; the API is authoritative and rejects too.
export const workoutExerciseEntrySchema = z.object({
  exerciseId: z.number().int().positive(),
  restSecondsBetweenSets: z.number().int().min(0).optional(),
  notes: z.string().optional(),
  sets: z.array(exerciseSetEntrySchema).max(10).default([]),
})

export const workoutCreateSchema = workoutInputSchema.extend({
  exercises: z.array(workoutExerciseEntrySchema).max(20).default([]),
})

// `exercises` is required (may be `[]`, which empties the workout): a PUT with
// no list is more likely a bug than an intent to clear the workout.
export const replaceWorkoutExercisesSchema = z.object({
  exercises: z.array(workoutExerciseEntrySchema).max(20),
})

export const cloneWorkoutSchema = z.object({
  targetTrainingPlanId: z.number().int().positive(),
  name: z.string().min(1),
  dayOfWeek: dayOfWeekSchema,
})
