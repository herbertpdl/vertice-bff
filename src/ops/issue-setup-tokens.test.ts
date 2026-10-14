import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { grpcCall } from '../grpc/call.js'
import jwt from 'jsonwebtoken'
import {
  addFakeUsers,
  API_SERVICE_SUBJECT_RPCS,
  emailOf,
  fakeGrpcCall,
  ids,
  listUsersPageCalls,
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
    expect(grpcCallMock.mock.calls.find(([, m]) => m === 'ListUsers')?.[2]).toEqual({
      role: 'CLIENT',
      pageSize: 100,
      pageToken: '',
    })
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

  describe('with more clients than one ListUsers page (100)', () => {
    let extra: ReturnType<typeof addFakeUsers>
    let trainer: ReturnType<typeof addFakeUsers>
    beforeEach(() => {
      extra = addFakeUsers(250)
      // A TRAINER after them: the role filter applies on every page, not just the first.
      trainer = addFakeUsers(1, 'TRAINER')
    })
    afterEach(() => {
      trainer.remove()
      extra.remove()
    })

    it('pages until next_page_token is empty and issues a token to every client exactly once', async () => {
      const lines: string[] = []
      const count = await issueSetupTokens({ dryRun: false, write: (line) => lines.push(line), callerToken: opsToken })
      const expected = [...clientIds, ...extra.ids]
      expect(count).toBe(expected.length)
      expect(listUsersPageCalls).toEqual([
        { pageSize: 100, pageToken: '' },
        { pageSize: 100, pageToken: expect.stringMatching(/.+/) },
        { pageSize: 100, pageToken: expect.stringMatching(/.+/) },
      ])
      const issuedTo = lines.slice(1).map((line) => Number(line.split(',')[0]))
      expect(issuedTo).toEqual(expected)
      expect(grpcCallMock.mock.calls.filter(([, m]) => m === 'CreatePasswordSetupToken')).toHaveLength(expected.length)
      // Every page went out with its own service:ops token.
      expect(new Set(upstreamCallers.map((c) => c.caller))).toEqual(new Set(['service:ops']))
    })

    it('lists every client on a dry run too', async () => {
      const lines: string[] = []
      await issueSetupTokens({ dryRun: true, write: (line) => lines.push(line), callerToken: opsToken })
      expect(lines).toHaveLength(1 + clientIds.length + extra.ids.length)
      expect(lines.at(-1)).toBe(`${extra.ids.at(-1)},${emailOf(extra.ids.at(-1)!)}`)
    })
  })

  it('stops instead of looping when upstream hands back the same page token twice', async () => {
    grpcCallMock.mockImplementation(async (_client, method) => {
      if (method === 'ListUsers') return { users: [], nextPageToken: 'stuck' } as never
      throw new Error(`unexpected ${method}`)
    })
    await expect(issueSetupTokens({ dryRun: true, write: () => {}, callerToken: opsToken })).rejects.toThrow(
      /same next_page_token twice/,
    )
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
