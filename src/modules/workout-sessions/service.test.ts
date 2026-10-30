import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grpcCall } from '../../grpc/call.js'
import { listProgressExercises } from './service.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

describe('listProgressExercises', () => {
  beforeEach(() => grpcCallMock.mockReset())

  it('asks ListProgressExercises for the client and keeps upstream order, with numeric ids', async () => {
    grpcCallMock.mockResolvedValue({ exercises: [{ id: '9', name: 'Supino' }, { id: '3', name: 'Agachamento' }] })

    const exercises = await listProgressExercises(4)

    expect(grpcCallMock.mock.calls[0]?.[1]).toBe('ListProgressExercises')
    expect(grpcCallMock.mock.calls[0]?.[2]).toEqual({ clientId: 4 })
    expect(exercises).toEqual([
      { id: 9, name: 'Supino' },
      { id: 3, name: 'Agachamento' },
    ])
  })
})
