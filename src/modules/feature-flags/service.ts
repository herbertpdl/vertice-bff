import type * as grpc from '@grpc/grpc-js'
import type { FastifyBaseLogger } from 'fastify'
import { grpcCall } from '../../grpc/call.js'
import { featureFlagClient } from '../../grpc/clients.js'
import { HttpError } from '../../lib/errors.js'

/**
 * Feature-flag evaluation (spec `docs/specs/feature-flags/spec.md`, FF4, FF6). The BFF owns no
 * flag data and evaluates nothing itself: vertice-api answers for the caller, with their own token.
 * No routes, no cache (FF15).
 */

/** The flag behind the AI workout assistant (`/assistant/status`, `/assistant/workout-chat`). */
export const AI_ASSISTANT_FLAG = 'AI_ASSISTANT_ENABLED'

/**
 * How long one evaluation may take. Above Aurora's ~15 s resume, so the first trainer after a
 * pause isn't told "off" because the database was waking up (FF4).
 */
export const FLAG_EVALUATION_DEADLINE_MS = 20_000

/**
 * Whether `key` is on for the caller (their token). Never rejects: any failure is off (R22), with
 * one WARN that carries no user data. `client` and `deadlineMs` exist for the real-channel test
 * (spec §8); production passes neither.
 */
export async function isFlagOn(
  key: string,
  log: FastifyBaseLogger,
  client: grpc.Client = featureFlagClient,
  deadlineMs: number = FLAG_EVALUATION_DEADLINE_MS,
): Promise<boolean> {
  try {
    const res = await grpcCall<{ key: string }, { enabled: boolean }>(
      client,
      'EvaluateFeatureFlag',
      { key },
      { deadlineMs },
    )
    return res.enabled === true
  } catch (err) {
    log.warn({ flag: key, outcome: 'evaluation_failed', code: codeOf(err) }, 'Feature flag evaluation failed; treating it as off')
    return false
  }
}

/** The `HttpError` code, else the error's name; never its message. */
function codeOf(err: unknown): string {
  if (err instanceof HttpError) return err.code
  if (err instanceof Error) return err.name
  return 'UNKNOWN'
}
