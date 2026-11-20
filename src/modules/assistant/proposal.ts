import { z } from 'zod'
import { MAX_EXERCISES_PER_WORKOUT, MAX_SETS_PER_EXERCISE, boundedText, restSeconds } from '../../lib/validation.js'
import { exerciseSetEntrySchema } from '../workouts/schemas.js'
import type { Exercise } from '../exercises/service.js'
import type { ExerciseSetEntry } from '../workouts/service.js'
import { exerciseKeySchema } from './schemas.js'

/**
 * The model's proposal is untrusted input (BFF assessment F5, PRD R27–R32). It must be exactly a
 * list of workout entries the editor could save with `PUT /workouts/:id/exercises`: the same field
 * bounds and 20/10 caps, nothing else (strict objects: a `name`, a `dayOfWeek` or any other field
 * makes it invalid, R28), every exercise from the trainer's catalog (R29), and every `key` one the
 * web sent, at most once. Anything else is `AI_INVALID_PROPOSAL` and no proposal reaches the web
 * (R32).
 */
const proposalSetSchema = exerciseSetEntrySchema.strict()

const proposalEntrySchema = z.strictObject({
  key: exerciseKeySchema.nullable().optional(),
  exerciseId: z.number().int().positive(),
  restSecondsBetweenSets: restSeconds.optional(),
  notes: boundedText(255).optional(),
  sets: z.array(proposalSetSchema).max(MAX_SETS_PER_EXERCISE).default([]),
})

const proposalSchema = z.strictObject({
  exercises: z.array(proposalEntrySchema).max(MAX_EXERCISES_PER_WORKOUT),
})

/** One proposal entry as the web gets it: the saveable entry, its key, and the exercise to render. */
export interface ProposalEntry {
  /** The on-screen exercise this entry modifies, or `null` when it is new. */
  key: string | null
  exerciseId: number
  restSecondsBetweenSets?: number
  notes?: string
  sets: ExerciseSetEntry[]
  exercise: Exercise
}

export interface Proposal {
  exercises: ProposalEntry[]
}

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; reason: string }

/** Validates and enriches a proposal. `reason` is for the log only (field paths, never values). */
export function validateProposal(
  raw: unknown,
  catalog: Map<number, Exercise>,
  sentKeys: Set<string>,
): ProposalResult {
  const parsed = proposalSchema.safeParse(raw)
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 5)
    return { ok: false, reason: `schema: ${paths.join(', ')}` }
  }
  const seen = new Set<string>()
  const exercises: ProposalEntry[] = []
  for (const [index, entry] of parsed.data.exercises.entries()) {
    const exercise = catalog.get(entry.exerciseId)
    if (!exercise) return { ok: false, reason: `exercises.${index}.exerciseId not in the catalog` }
    const key = entry.key ?? null
    if (key !== null) {
      if (!sentKeys.has(key)) return { ok: false, reason: `exercises.${index}.key not sent` }
      if (seen.has(key)) return { ok: false, reason: `exercises.${index}.key repeated` }
      seen.add(key)
    }
    exercises.push({
      key,
      exerciseId: entry.exerciseId,
      ...(entry.restSecondsBetweenSets === undefined ? {} : { restSecondsBetweenSets: entry.restSecondsBetweenSets }),
      ...(entry.notes === undefined ? {} : { notes: entry.notes }),
      sets: entry.sets,
      exercise,
    })
  }
  return { ok: true, proposal: { exercises } }
}
