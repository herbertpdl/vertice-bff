import { z } from 'zod'

/**
 * The BFF ↔ vertice-ai contract for the workout assistant: what the BFF sends to
 * `POST /v1/workout-chat` and the events it reads back. vertice-ai's spec
 * (https://github.com/herbertpdl/vertice-ai/blob/main/docs/specs/ai-workout-assistant/spec.md)
 * is the source of truth; this file mirrors it, and nothing outside `src/ai/` and
 * `modules/assistant/` depends on its shapes.
 */

export const AI_WORKOUT_CHAT_PATH = '/v1/workout-chat'

/**
 * The stage keys vertice-ai reports (spec §4: each at most once, in this order, later ones may be
 * skipped); the web maps each one to its own pt-BR label.
 */
export const ASSISTANT_STAGES = ['analyzing', 'choosing_exercises', 'building_sets', 'checking'] as const
export type AssistantStage = (typeof ASSISTANT_STAGES)[number]

export interface AiSetEntry {
  reps?: number
  durationSeconds?: number
  weight?: string
  loadPercentage?: string
  strategy?: string
  restSeconds?: number
  notes?: string
}

export interface AiWorkoutChatRequest {
  message: string
  history: { role: 'user' | 'assistant'; text: string }[]
  plan: { name: string; description: string; level: string; startDate: string; endDate: string }
  /** The workout on screen: `name`/`dayOfWeek` only when it already exists (context, never changed). */
  workout: {
    name?: string
    dayOfWeek?: string
    exercises: {
      key: string
      exerciseId: number
      restSecondsBetweenSets?: number
      notes?: string
      sets: AiSetEntry[]
    }[]
  }
  /** The plan's other workouts (at most 50), summarized: enough to balance the week. */
  otherWorkouts: {
    name: string
    dayOfWeek: string
    /** At most 20; `muscleGroups` at most 50; `sets` is the number of sets, 0–10. */
    exercises: { name: string; muscleGroups: string[]; sets: number }[]
  }[]
  /** Every exercise the trainer may use (R29), at most 1,000, unique ids; a proposal may name no other id. */
  catalog: { id: number; name: string; muscleGroups: string[] }[]
  /**
   * The trainer's anamnese of the plan's client, as stored (client-anamnese R22, R24): the only
   * client-derived text. Omitted when there is none or the read was refused; never empty.
   */
  anamnese?: string
}

/** vertice-ai spec §3 bounds the BFF trims to rather than send a 400-bound body. */
export const AI_MAX_OTHER_WORKOUTS = 50
export const AI_MAX_MUSCLE_GROUPS = 50
export const AI_MAX_CATALOG = 1_000
/**
 * vertice-ai's anamnese bound, in code points (its client-anamnese spec). The BFF's 5,000 UTF-16
 * units (`ANAMNESE_MAX_LENGTH`) are never more, so anything vertice-api stored passes.
 */
export const AI_MAX_ANAMNESE = 5_000

// ---- events vertice-ai streams back -------------------------------------------------------------

/** `exercise` (1-based) only on `building_sets`, which repeats once per exercise being written. */
export const aiStageEventSchema = z.object({ stage: z.string(), exercise: z.number().int().positive().optional() })
/**
 * `line` (client-anamnese spec §4): absent on answer text, else a marker the BFF checks before
 * relaying (`session.ts`); parsed as `unknown` so a bad one degrades to text instead of failing.
 */
export const aiTextEventSchema = z.object({ delta: z.string(), line: z.unknown().optional() })

/** The `line` values a `text` event may carry, each one whole line, at most once, in this order. */
export const ASSISTANT_LINES = ['left_out', 'anamnese_conflict'] as const
export type AssistantLine = (typeof ASSISTANT_LINES)[number]
/** vertice-ai's bound on a line event's text, in code points. */
export const AI_MAX_LINE = 300
/** Parsed loosely here; `modules/assistant/proposal.ts` validates it strictly (R27–R32). */
export const aiProposalEventSchema = z.object({ exercises: z.unknown() }).passthrough()
export const aiErrorEventSchema = z.object({ code: z.string(), message: z.string().optional() })
/** `done` carries metadata the BFF only logs (spec §4); the web gets an empty `done`. */
export const aiDoneEventSchema = z
  .object({
    model: z.string().nullish(),
    promptVersion: z.string().nullish(),
    usage: z.object({ inputTokens: z.number().nullish(), outputTokens: z.number().nullish() }).nullish(),
  })
  .passthrough()

/**
 * vertice-ai's `error` codes onto the BFF's (spec §4): `UPSTREAM_UNAVAILABLE` → `AI_UNAVAILABLE`,
 * `INVALID_PROPOSAL` → `AI_INVALID_PROPOSAL`, anything else (`UPSTREAM_BAD_RESPONSE`,
 * `INTERNAL_ERROR`, an unknown code) → `AI_ERROR`.
 */
export const AI_UPSTREAM_UNAVAILABLE_CODES = new Set(['UPSTREAM_UNAVAILABLE'])
export const AI_UPSTREAM_INVALID_PROPOSAL_CODES = new Set(['INVALID_PROPOSAL'])
