import { z } from 'zod'
import { utf16String } from '../../lib/validation.js'
import { workoutExerciseEntrySchema } from '../workouts/schemas.js'
import { MAX_EXERCISES_PER_WORKOUT } from '../../lib/validation.js'

/** PRD R10: a trainer's message, counted in UTF-16 units like the web's `string.length`. */
export const MAX_MESSAGE_LENGTH = 2_000
/** PRD R56: the history the web sends with each message (it trims the oldest turns first). */
export const MAX_HISTORY_TURNS = 20
export const MAX_HISTORY_CHARACTERS = 40_000

/**
 * An opaque client key (the editor model's `key`): echoed back on the proposal entry that modifies
 * that exercise, so the web can tell "Alterado" from "Novo" + "Removido" (PRD R33).
 */
export const exerciseKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected 1 to 64 letters, digits, _ or -')

/** A workout entry plus its key. Same caps and field bounds as `PUT /workouts/:id/exercises`. */
export const keyedWorkoutExerciseEntrySchema = workoutExerciseEntrySchema
  .extend({ key: exerciseKeySchema })
  .meta({ id: 'AssistantWorkoutExerciseEntry' })

export const assistantHistoryTurnSchema = z
  .object({ role: z.enum(['user', 'assistant']), text: utf16String(MAX_HISTORY_CHARACTERS).min(1) })
  .meta({ id: 'AssistantHistoryTurn' })

export const workoutChatRequestSchema = z
  .object({
    trainingPlanId: z.number().int().positive(),
    /** Absent on a workout that does not exist yet (PRD R2). */
    workoutId: z.number().int().positive().optional(),
    /**
     * The workout as it stands on screen, a proposal in review and the trainer's edits included
     * (R12, R36). No name or weekday: the assistant never changes either (R28).
     */
    workout: z.object({
      exercises: z
        .array(keyedWorkoutExerciseEntrySchema)
        .max(MAX_EXERCISES_PER_WORKOUT)
        .refine((entries) => new Set(entries.map((e) => e.key)).size === entries.length, 'keys must be unique'),
    }),
    /** Earlier turns, text only, oldest first. Proposals never go here: the current one is `workout`. */
    history: z
      .array(assistantHistoryTurnSchema)
      .max(MAX_HISTORY_TURNS)
      .refine(
        (turns) => turns.reduce((sum, t) => sum + t.text.length, 0) <= MAX_HISTORY_CHARACTERS,
        `history must total at most ${MAX_HISTORY_CHARACTERS} characters`,
      )
      .default([]),
    message: utf16String(MAX_MESSAGE_LENGTH).refine((m) => m.trim().length > 0, 'message must not be blank'),
  })
  .meta({ id: 'WorkoutChatRequest' })

export type WorkoutChatRequest = z.infer<typeof workoutChatRequestSchema>

/** `GET /assistant/anamnese-notice` query: the plan open in the editor; nothing else is accepted. */
export const anamneseNoticeQuerySchema = z
  .object({
    trainingPlanId: z
      .string()
      .regex(/^\d{1,15}$/, 'expected a positive integer')
      .transform(Number)
      .refine((id) => id > 0, 'expected a positive integer'),
  })
  .strict()
