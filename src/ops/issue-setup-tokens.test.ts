import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { grpcCall } from '../grpc/call.js'
import jwt from 'jsonwebtoken'
import {
  API_SERVICE_SUBJECT_RPCS,
  emailOf,
  fakeGrpcCall,
  ids,
  resetUpstreamCallers,
  setupTokenFor,
  upstreamCallers,
} from '../test/fakeUpstream.js'
import { issueSetupTokens } from './issue-setup-tokens.js'
import { OPS_TOKEN_RPCS, opsToken } from './ops-token.js'

vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

const clientIds = [ids.clientA, ids.clientB, ids.clientA2]

describe('issueSetupTokens', () => {
  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
    resetUpstreamCallers()
  })

  it('issues a token to every CLIENT (including legacy ones with a password) and prints the link paths', async () => {
    const lines: string[] = []
    const count = await issueSetupTokens({ dryRun: false, write: (line) => lines.push(line), callerToken: opsToken })
    expect(count).toBe(3)
    expect(grpcCallMock.mock.calls.find(([, m]) => m === 'ListUsers')?.[2]).toEqual({ role: 'CLIENT' })
    expect(lines).toEqual([
      'userId,email,linkPath,expiresAt',
      ...clientIds.map((id) => `${id},${emailOf(id)},/definir-senha?token=${setupTokenFor(id)},2099-01-01T00:00:00Z`),
    ])
  })

  it('issues nothing on a dry run', async () => {
    const lines: string[] = []
    await issueSetupTokens({ dryRun: true, write: (line) => lines.push(line), callerToken: opsToken })
    expect(grpcCallMock.mock.calls.map(([, m]) => m)).toEqual(['ListUsers'])
    expect(lines).toEqual(['userId,email', ...clientIds.map((id) => `${id},${emailOf(id)}`)])
  })

  it('calls upstream as service:ops, never as the BFF or a user', async () => {
    await issueSetupTokens({ dryRun: false, write: () => {}, callerToken: opsToken })
    expect(new Set(upstreamCallers.map((c) => c.caller))).toEqual(new Set(['service:ops']))
  })

  it('mints a scoped, short-lived service:ops token allowed on exactly what the script needs', () => {
    const claims = jwt.verify(opsToken(), env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'vertice-bff',
      audience: 'vertice-api',
    }) as jwt.JwtPayload
    expect(claims).toMatchObject({ sub: 'service:ops', role: 'SERVICE' })
    expect(claims.exp! - claims.iat!).toBe(60)
    expect([...OPS_TOKEN_RPCS].sort()).toEqual(['CreatePasswordSetupToken', 'ListUsers'])
    expect([...OPS_TOKEN_RPCS].sort()).toEqual([...API_SERVICE_SUBJECT_RPCS['service:ops']!].sort())
  })
})
