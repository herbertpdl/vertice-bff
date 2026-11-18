import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grpcCall } from '../grpc/call.js'
import {
  emailOf,
  fakeGrpcCall,
  ids,
  resetFakeSecondFactors,
  resetUpstreamCallers,
  setupTokenFor,
  upstreamCallers,
} from '../test/fakeUpstream.js'
import {
  createAdmin,
  issueAdminSetupToken,
  parseCreateAdminArgs,
  parseUserIdArgs,
  resetAdminSecondFactor,
} from './admin-ops.js'
import { opsToken } from './ops-token.js'

vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

describe('admin ops scripts', () => {
  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
    resetUpstreamCallers()
    resetFakeSecondFactors()
  })

  it('creates an admin and answers the www "Definir senha" link, as service:ops', async () => {
    const setup = await createAdmin({ name: 'Ana', email: 'ana@vertice.fit' }, opsToken)
    expect(setup).toEqual({
      userId: 98,
      setupLink: `https://www.vertice.fit/definir-senha?token=${setupTokenFor(98)}`,
      expiresAt: '2099-01-01T00:00:00Z',
    })
    expect(grpcCallMock.mock.calls[0]![2]).toEqual({ name: 'Ana', email: 'ana@vertice.fit' })
    expect(upstreamCallers).toEqual([{ method: 'CreateAdmin', caller: 'service:ops' }])
  })

  it('issues a new setup link to an admin, and refuses a non-admin id (NOT_FOUND)', async () => {
    expect((await issueAdminSetupToken(ids.admin, opsToken)).setupLink).toBe(
      `https://www.vertice.fit/definir-senha?token=${setupTokenFor(ids.admin)}`,
    )
    await expect(issueAdminSetupToken(ids.trainerA, opsToken)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('resets the second factor as service:ops', async () => {
    await resetAdminSecondFactor(ids.admin, opsToken)
    expect(upstreamCallers).toEqual([{ method: 'ResetAdminSecondFactor', caller: 'service:ops' }])
  })

  it('is refused upstream without the ops token (the BFF never calls AdminOpsService)', async () => {
    await expect(resetAdminSecondFactor(ids.admin, () => 'forged')).rejects.toThrow()
  })

  describe('arguments', () => {
    it('reads --name and --email, the email normalized', () => {
      expect(parseCreateAdminArgs(['--name', ' Ana ', '--email', ' ANA@Vertice.fit '])).toEqual({
        ok: true,
        value: { name: 'Ana', email: 'ana@vertice.fit' },
      })
    })

    it.each([
      [['--name', 'Ana']],
      [['--name', 'Ana', '--email', 'not-an-email']],
      [['--name', '  ', '--email', emailOf(1)]],
      [['--name', 'Ana', '--email', emailOf(1), '--role', 'ADMIN']],
      [['--name', 'Ana', '--email', emailOf(1), 'extra']],
    ])('refuses %j', (args) => {
      const parsed = parseCreateAdminArgs(args)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.message).toContain('Usage: ops:create-admin')
    })

    it('reads --user-id as a positive integer', () => {
      expect(parseUserIdArgs(['--user-id', '42'], 's')).toEqual({ ok: true, value: { 'user-id': 42 } })
      for (const args of [[], ['--user-id', '0'], ['--user-id', 'x'], ['--user-id', '1.5'], ['--user-id', '1', '--dry-run'], ['--id', '1']]) {
        expect(parseUserIdArgs(args, 's').ok, args.join(' ')).toBe(false)
      }
    })
  })
})
