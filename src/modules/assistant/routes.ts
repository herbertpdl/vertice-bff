import { PassThrough } from 'node:stream'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { httpAiClient, type AiClient } from '../../ai/client.js'
import { HttpError } from '../../lib/errors.js'
import type { AuthUser } from '../../lib/jwt.js'
import { z } from 'zod'
import { routeDoc } from '../../openapi/docs.js'
import { anamneseNoticeSchema, assistantStatusSchema, assistantStreamSchema } from '../../openapi/responses.js'
import { anamneseNoticeQuerySchema, workoutChatRequestSchema } from './schemas.js'
import { AI_ASSISTANT_FLAG, isFlagOn } from '../feature-flags/service.js'
import { buildChatContext, getAnamneseNotice } from './service.js'
import { ChatSlots, DEFAULT_CHAT_TIMINGS, runChat, type ChatTimings } from './session.js'

/**
 * The AI workout assistant (spec `docs/specs/ai-workout-assistant/spec.md`). TRAINER only. The
 * BFF's first streamed response and its first call to vertice-ai.
 */

export interface AssistantSettings {
  /**
   * Whether the `AI_ASSISTANT_ENABLED` flag is on for this trainer (feature-flags spec FF4, FF6):
   * one `EvaluateFeatureFlag` per request with their token, no cache. Never rejects; any failure is
   * off. Off: the chat route answers 503 `AI_UNAVAILABLE` and calls nothing.
   */
  isEnabledFor: (user: AuthUser, log: FastifyBaseLogger) => Promise<boolean>
  /** vertice-ai; built whenever `VERTICE_AI_URL` is set. Without it the assistant is off for everyone. */
  client?: AiClient
  timings: ChatTimings
}

export function assistantSettingsFromEnv(overrides: Partial<AssistantSettings> = {}): AssistantSettings {
  const client = overrides.client ?? (env.VERTICE_AI_URL ? httpAiClient(env.VERTICE_AI_URL) : undefined)
  const isEnabledFor = overrides.isEnabledFor ?? ((_user: AuthUser, log: FastifyBaseLogger) => isFlagOn(AI_ASSISTANT_FLAG, log))
  return { isEnabledFor, client, timings: { ...DEFAULT_CHAT_TIMINGS, ...overrides.timings } }
}

export interface AssistantStatus {
  /** Whether the web shows the AI icon in the workout editor. */
  enabled: boolean
}

/** Mounted at /api/assistant */
export default async function assistantRoutes(app: FastifyInstance, opts: { settings: AssistantSettings }) {
  const { settings } = opts
  const slots = new ChatSlots()
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get(
    '/status',
    {
      schema: routeDoc({
        operationId: 'getAssistantStatus',
        summary: 'Whether the AI workout assistant is on for this trainer',
        description:
          'Per trainer: the `AI_ASSISTANT_ENABLED` feature flag, read with one `EvaluateFeatureFlag` call ' +
          'with the trainer’s token (20 s deadline, no cache). Always 200: any failure to read the flag, or a ' +
          'BFF with no vertice-ai configured, answers `false`. May lag an admin change by up to 30 s (the ' +
          'API’s cache). The web hides the AI icon while `enabled` is false.',
        tag: 'Assistant',
        roles: ['TRAINER'],
        ok: { status: 200, description: 'Whether the assistant is on for the caller.', schema: assistantStatusSchema },
      }),
    },
    async (req): Promise<AssistantStatus> => ({
      // No client: nothing the flag could say is useful, so it isn't read (FF3).
      enabled: settings.client !== undefined && (await settings.isEnabledFor(req.user!, req.log)),
    }),
  )

  // The AI panel's anamnese notice (client-anamnese spec §2.3). Not flag-gated (Q3): it carries no
  // AI data and never the text, and the web calls it only inside the panel.
  app.get(
    '/anamnese-notice',
    {
      schema: routeDoc({
        operationId: 'getAnamneseNotice',
        summary: 'Whether the AI uses the anamnese of this plan’s client',
        description:
          'For the plan open in the editor (yours): `present` or `missing` with the client’s id and name (the ' +
          'link to their anamnese tab), or `unavailable` with `client: null` when the client is no longer yours. ' +
          'Never returns the anamnese itself. Each chat message reads the anamnese again, so this can lag a save ' +
          'made since.',
        tag: 'Assistant',
        roles: ['TRAINER'],
        query: z.object({ trainingPlanId: z.number().int().positive().describe('The plan open in the editor.') }),
        ok: { status: 200, description: 'The notice state.', schema: anamneseNoticeSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const { trainingPlanId } = anamneseNoticeQuerySchema.parse(req.query)
      return getAnamneseNotice(req.user!, trainingPlanId)
    },
  )

  app.post(
    '/workout-chat',
    {
      schema: routeDoc({
        operationId: 'workoutChat',
        summary: 'Send a message to the AI workout assistant (server-sent events)',
        description:
          'Answers `text/event-stream` (see `AssistantStreamEvent` and docs/api-contract.md, "AI workout assistant"). ' +
          'Before the stream: 400 (body, a workout of another plan, an exercise outside the trainer’s catalog), ' +
          '403 (another trainer’s plan or workout), 413 `AI_CATALOG_TOO_LARGE`, 503 `AI_UNAVAILABLE` (the ' +
          '`AI_ASSISTANT_ENABLED` flag is off for this trainer or cannot be read, or vertice-ai is not configured; ' +
          'checked first, so nothing else is read). ' +
          'Once streaming, failures are an `error` event (`AI_UNAVAILABLE`, `AI_TIMEOUT`, `AI_INVALID_PROPOSAL`, ' +
          '`AI_ERROR`, `AI_SUPERSEDED`) and the stream ends. A new message from the same trainer supersedes a running one.',
        tag: 'Assistant',
        roles: ['TRAINER'],
        body: workoutChatRequestSchema,
        ok: {
          status: 200,
          description: 'The event stream: `stage`, `text`, `proposal`, then `done` or `error`.',
          schema: assistantStreamSchema,
          contentType: 'text/event-stream',
        },
        errors: [403, 404, 413, 503],
      }),
    },
    async (req, reply) => {
      // The flag first (FF5): an off trainer triggers no catalog read and no vertice-ai call. A
      // stream already running when the flag turns off finishes; the next message is refused.
      const on = await settings.isEnabledFor(req.user!, req.log)
      if (!on) throw new HttpError(503, 'The AI assistant is switched off', 'AI_UNAVAILABLE')
      const client = settings.client
      if (!client) {
        req.log.warn(
          { assistant: 'unavailable', reason: 'no_client', userId: req.user!.id },
          'AI flag on but VERTICE_AI_URL is not set',
        )
        throw new HttpError(503, 'The AI assistant is unavailable', 'AI_UNAVAILABLE')
      }
      const body = workoutChatRequestSchema.parse(req.body)
      const user = req.user!

      // The web may give up while the context is read (R16, R50): then nothing goes to vertice-ai.
      let gone = false
      const onClose = () => {
        gone = true
      }
      reply.raw.once('close', onClose)
      const context = await buildChatContext(user, body)
      reply.raw.off('close', onClose)
      if (gone || reply.raw.destroyed) return reply.hijack()

      const handle = slots.acquire(user.id)
      const stream = new PassThrough()
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) handle.stop('client')
      })
      reply
        .status(200)
        .header('content-type', 'text/event-stream; charset=utf-8')
        // `no-store` comes from the security-headers hook; this keeps nginx-style proxies from buffering.
        .header('x-accel-buffering', 'no')
      void runChat({
        client,
        context,
        user,
        handle,
        requestId: req.id,
        timings: settings.timings,
        write: (chunk) => {
          if (!stream.writableEnded && !stream.destroyed) stream.write(chunk)
        },
        log: req.log,
      }).finally(() => {
        slots.release(user.id, handle)
        stream.end()
      })
      return reply.send(stream)
    },
  )
}
