import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grpcCall } from '../grpc/call.js'
import { emailOf, fakeGrpcCall, ids, setupTokenFor } from '../test/fakeUpstream.js'
import { issueSetupTokens } from './issue-setup-tokens.js'

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
  })

  it('issues a token to every CLIENT (including legacy ones with a password) and prints the link paths', async () => {
    const lines: string[] = []
    const count = await issueSetupTokens({ dryRun: false, write: (line) => lines.push(line) })
    expect(count).toBe(3)
    expect(grpcCallMock.mock.calls.find(([, m]) => m === 'ListUsers')?.[2]).toEqual({ role: 'CLIENT' })
    expect(lines).toEqual([
      'userId,email,linkPath,expiresAt',
      ...clientIds.map((id) => `${id},${emailOf(id)},/definir-senha?token=${setupTokenFor(id)},2099-01-01T00:00:00Z`),
    ])
  })

  it('issues nothing on a dry run', async () => {
    const lines: string[] = []
    await issueSetupTokens({ dryRun: true, write: (line) => lines.push(line) })
    expect(grpcCallMock.mock.calls.map(([, m]) => m)).toEqual(['ListUsers'])
    expect(lines).toEqual(['userId,email', ...clientIds.map((id) => `${id},${emailOf(id)}`)])
  })
})
