import { HttpError, ValidationError } from '../../lib/errors.js'
import type { AuthUser } from '../../lib/jwt.js'
import { assertOwnsPlan } from '../../lib/ownership.js'
import { MAX_EXERCISES_PER_WORKOUT, MAX_SETS_PER_EXERCISE } from '../../lib/validation.js'
import { AI_MAX_CATALOG, AI_MAX_MUSCLE_GROUPS, AI_MAX_OTHER_WORKOUTS, type AiWorkoutChatRequest } from '../../ai/contract.js'
import * as exerciseService from '../exercises/service.js'
import * as exerciseSetService from '../exercise-sets/service.js'
import * as planService from '../training-plans/service.js'
import * as workoutExerciseService from '../workout-exercises/service.js'
import * as workoutService from '../workouts/service.js'
import type { WorkoutChatRequest } from './schemas.js'

/**
 * Context building for the workout assistant (BFF assessment F2, F4, F9). Everything is read with
 * the trainer's own token, so vertice-api applies its own visibility rules. What reaches vertice-ai
 * is built field by field: the plan's name, description, level and dates, the workouts' content,
 * and the catalog. Never the plan's `clientId`, the client's name or e-mail, logs, recorded weights
 * or feedback (PRD R13).
 */

/** The catalog page size used to load it whole (the upstream maximum). */
const CATALOG_PAGE_SIZE = 50
/**
 * The most exercises sent as the catalog (F2, option (a)): the starter set is about 200, plus the
 * trainer's own. Past this the message is refused rather than sent with a partial catalog, which
 * would make the AI miss exercises it should know.
 */
export const MAX_CATALOG_EXERCISES = AI_MAX_CATALOG

export interface ChatContext {
  request: AiWorkoutChatRequest
  /** The trainer's visible catalog by id: proposal validation and enrichment (F5). */
  catalog: Map<number, exerciseService.Exercise>
  /** The keys the web sent, each with its exercise: a proposal may echo only these, on the same exercise. */
  keys: Map<string, number>
}

/** The trainer's whole visible catalog, paged through `ListExercises` with their token. */
export async function loadCatalog(): Promise<Map<number, exerciseService.Exercise>> {
  const catalog = new Map<number, exerciseService.Exercise>()
  let cursor: string | undefined
  do {
    const page = await exerciseService.listExercises({ limit: CATALOG_PAGE_SIZE, cursor })
    for (const exercise of page.exercises) catalog.set(exercise.id, exercise)
    if (catalog.size > MAX_CATALOG_EXERCISES) {
      throw new HttpError(
        413,
        `The exercise catalog has more than ${MAX_CATALOG_EXERCISES} exercises, too many for the assistant`,
        'AI_CATALOG_TOO_LARGE',
      )
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return catalog
}

/** Other workouts summarized at once, so one message never has hundreds of reads in flight. */
const CONTEXT_READ_CONCURRENCY = 4

/** `Promise.all(items.map(fn))` with at most `limit` running at once; results keep the input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const muscleGroupNames = (exercise: exerciseService.Exercise) =>
  exercise.muscleGroups.slice(0, AI_MAX_MUSCLE_GROUPS).map((g) => g.name)

/**
 * Checks ownership and the body's ids, then reads everything vertice-ai gets. Throws (as a normal
 * HTTP error, before any byte of the stream) when the plan or workout is not the trainer's (403),
 * the workout is in another plan (400), or an on-screen exercise is not in their catalog (400, the
 * same answer for a missing id and another trainer's private one, so it is no existence oracle).
 */
export async function buildChatContext(user: AuthUser, body: WorkoutChatRequest): Promise<ChatContext> {
  const plan = await planService.getTrainingPlan(body.trainingPlanId)
  assertOwnsPlan(user, plan)

  let current: workoutService.Workout | undefined
  if (body.workoutId !== undefined) {
    current = await workoutService.getWorkout(body.workoutId)
    if (current.trainingPlanId !== plan.id) {
      // Not this plan's: refuse another trainer's workout as such (403), the trainer's own as a 400.
      assertOwnsPlan(user, await planService.getTrainingPlan(current.trainingPlanId))
      throw new ValidationError('workoutId does not belong to this training plan')
    }
  }

  const [catalog, planWorkouts] = await Promise.all([loadCatalog(), workoutService.listWorkouts(plan.id)])

  for (const entry of body.workout.exercises) {
    if (!catalog.has(entry.exerciseId)) throw new ValidationError(`exerciseId ${entry.exerciseId} is not available to you`)
  }

  // vertice-ai takes at most 50 (spec §3), the first ones; a plan has one per weekday in practice.
  const others = planWorkouts.filter((w) => w.id !== current?.id).slice(0, AI_MAX_OTHER_WORKOUTS)
  // A few workouts at a time: each one fans out to one ListExerciseSets per exercise.
  const otherWorkouts = await mapWithLimit(others, CONTEXT_READ_CONCURRENCY, (w) => summarizeWorkout(w, catalog))

  const request: AiWorkoutChatRequest = {
    message: body.message,
    history: body.history.map(({ role, text }) => ({ role, text })),
    plan: {
      name: plan.name,
      description: plan.description,
      level: plan.level,
      startDate: plan.startDate,
      endDate: plan.endDate,
    },
    workout: {
      ...(current ? { name: current.name, dayOfWeek: current.dayOfWeek } : {}),
      exercises: body.workout.exercises.map((e) => ({
        key: e.key,
        exerciseId: e.exerciseId,
        ...(e.restSecondsBetweenSets === undefined ? {} : { restSecondsBetweenSets: e.restSecondsBetweenSets }),
        ...(e.notes === undefined ? {} : { notes: e.notes }),
        sets: e.sets.map((s) => ({ ...s })),
      })),
    },
    otherWorkouts,
    catalog: [...catalog.values()].map((e) => ({ id: e.id, name: e.name, muscleGroups: muscleGroupNames(e) })),
  }
  return { request, catalog, keys: new Map(body.workout.exercises.map((e) => [e.key, e.exerciseId])) }
}

/**
 * One other workout, as much as the AI needs to balance the week (F9): each exercise's name,
 * muscle groups and number of sets. `ListWorkoutExercises` plus one `ListExerciseSets` per
 * exercise; names come from the catalog already loaded, so no `GetExercise` per exercise. No
 * exercise ids: vertice-ai's contract has none here (only the catalog's ids may be proposed). An
 * exercise the trainer can no longer see (not in the catalog) is left out.
 */
async function summarizeWorkout(
  workout: workoutService.Workout,
  catalog: Map<number, exerciseService.Exercise>,
): Promise<AiWorkoutChatRequest['otherWorkouts'][number]> {
  const entries = (await workoutExerciseService.listWorkoutExercises(workout.id)).sort((a, b) => a.order - b.order)
  const exercises = await Promise.all(
    entries.map(async (we) => {
      const exercise = catalog.get(we.exerciseId)
      if (!exercise) return undefined
      const sets = await exerciseSetService.listExerciseSets(we.id)
      return { name: exercise.name, muscleGroups: muscleGroupNames(exercise), sets: Math.min(sets.length, MAX_SETS_PER_EXERCISE) }
    }),
  )
  return {
    name: workout.name,
    dayOfWeek: workout.dayOfWeek,
    exercises: exercises.filter((e) => e !== undefined).slice(0, MAX_EXERCISES_PER_WORKOUT),
  }
}
