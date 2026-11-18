import { Metadata } from '@grpc/grpc-js'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { adminOpsClient } from '../grpc/clients.js'
import { grpcCall } from '../grpc/call.js'
import { emailSchema } from '../modules/auth/schemas.js'
import { requiredText } from '../lib/validation.js'
import { setupLinkPath } from './issue-setup-tokens.js'

/**
 * Admin lifecycle for the platform team (admin-panel spec B6; vertice-api D9, `AdminOpsService`):
 * create an admin, issue a new setup link (forgotten password), reset a lost authenticator,
 * suspend and reactivate an admin (R14: the panel never suspends an admin). Only
 * the CLIs under `src/ops/cli/` call these, with their own `service:ops` token (`opsToken`); the
 * server never imports this module, and no route reaches `AdminOpsService`.
 *
 * The setup link is a credential: it goes to stdout only (the scripts), never to a logger.
 */

/** The deployed www, where the "Definir senha" page lives (the admin sets the password there). */
export const WEB_BASE_URL = 'https://www.vertice.fit'

export const setupLinkOf = (token: string) => `${WEB_BASE_URL}${setupLinkPath(token)}`

export interface AdminSetup {
  userId: number
  /** `https://www.vertice.fit/definir-senha?token=...`, single use. */
  setupLink: string
  expiresAt: string
}

const asOps = (callerToken: () => string) => {
  const metadata = new Metadata()
  metadata.set('authorization', `Bearer ${callerToken()}`)
  return { metadata }
}

/** `CreateAdmin`: an ADMIN with no password, and the link that lets them choose one. */
export async function createAdmin(input: { name: string; email: string }, callerToken: () => string): Promise<AdminSetup> {
  const res = await grpcCall<{ name: string; email: string }, { userId: string; setupToken: string; expiresAt: string }>(
    adminOpsClient,
    'CreateAdmin',
    { name: input.name, email: input.email },
    asOps(callerToken),
  )
  return { userId: Number(res.userId), setupLink: setupLinkOf(res.setupToken), expiresAt: res.expiresAt }
}

/** `IssueAdminSetupToken`: a new setup link for an existing admin; their unused ones stop working. */
export async function issueAdminSetupToken(userId: number, callerToken: () => string): Promise<AdminSetup> {
  const res = await grpcCall<{ userId: number }, { setupToken: string; expiresAt: string }>(
    adminOpsClient,
    'IssueAdminSetupToken',
    { userId },
    asOps(callerToken),
  )
  return { userId, setupLink: setupLinkOf(res.setupToken), expiresAt: res.expiresAt }
}

/** `ResetAdminSecondFactor`: deletes the authenticator and ends the admin's sessions; they enrol again at sign-in. */
export async function resetAdminSecondFactor(userId: number, callerToken: () => string): Promise<void> {
  await grpcCall(adminOpsClient, 'ResetAdminSecondFactor', { userId }, asOps(callerToken))
}

/**
 * `SuspendAdmin`: every session of the admin ends at their next call and their sign-in answers
 * 403 `ACCOUNT_SUSPENDED`. vertice-api refuses a non-admin id (NOT_FOUND) and an admin already
 * suspended (FAILED_PRECONDITION, the 409 `PRECONDITION_FAILED`).
 */
export async function suspendAdmin(userId: number, callerToken: () => string): Promise<void> {
  await grpcCall(adminOpsClient, 'SuspendAdmin', { userId }, asOps(callerToken))
}

/** `ReactivateAdmin`: the admin signs in again (old sessions stay void). FAILED_PRECONDITION when not suspended. */
export async function reactivateAdmin(userId: number, callerToken: () => string): Promise<void> {
  await grpcCall(adminOpsClient, 'ReactivateAdmin', { userId }, asOps(callerToken))
}

/** The command line of an admin script, or a usage message. Unknown arguments are refused. */
export type ParsedArgs<T> = { ok: true; value: T } | { ok: false; message: string }

const userIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

function parse<T>(args: string[], options: Record<string, { type: 'string' }>, schema: z.ZodType<T>, usage: string): ParsedArgs<T> {
  let values: Record<string, unknown>
  try {
    ;({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }))
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\nUsage: ${usage}` }
  }
  const parsed = schema.safeParse(values)
  if (!parsed.success) {
    const fields = Object.keys(z.flattenError(parsed.error).fieldErrors).map((field) => `--${field}`)
    return { ok: false, message: `Missing or invalid: ${fields.join(', ') || 'arguments'}\nUsage: ${usage}` }
  }
  return { ok: true, value: parsed.data }
}

export const parseCreateAdminArgs = (args: string[]) =>
  parse(
    args,
    { name: { type: 'string' }, email: { type: 'string' } },
    z.object({ name: requiredText(255), email: emailSchema }),
    'ops:create-admin -- --name <name> --email <email>',
  )

export const parseUserIdArgs = (args: string[], script: string) =>
  parse(args, { 'user-id': { type: 'string' } }, z.object({ 'user-id': userIdSchema }), `${script} -- --user-id <id>`)
