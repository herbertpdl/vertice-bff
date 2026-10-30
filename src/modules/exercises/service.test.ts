import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grpcCall } from '../../grpc/call.js'
import { listExercises, toExercise } from './service.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

describe('toExercise', () => {
  it('toExercise converts int64 strings to numbers, keeps muscleGroups in upstream order and passes isStarter through', () => {
    const exercise = toExercise({
      id: '7',
      name: 'Supino fechado',
      description: '',
      videoUrl: '',
      muscleGroups: [
        { id: '1', name: 'Peito' },
        { id: '5', name: 'Tríceps' },
      ],
      isStarter: true,
    })
    // `getFullWorkout` embeds this output unchanged, so this is also the shape of
    // `FullWorkoutExercise.exercise` on every composed workout endpoint.
    expect(exercise).toEqual({
      id: 7,
      name: 'Supino fechado',
      description: '',
      videoUrl: '',
      muscleGroups: [
        { id: 1, name: 'Peito' },
        { id: 5, name: 'Tríceps' },
      ],
      isStarter: true,
    })
    expect(exercise).not.toHaveProperty('muscleGroup')
  })

  it('toExercise yields an empty muscleGroups array when upstream sends none', () => {
    const exercise = toExercise({
      id: '8',
      name: 'x',
      description: '',
      videoUrl: '',
      isStarter: false,
    } as unknown as Parameters<typeof toExercise>[0])
    expect(exercise.muscleGroups).toEqual([])
  })
})

const row = { id: '7', name: 'Supino', description: '', videoUrl: '', muscleGroups: [], isStarter: true }

describe('listExercises', () => {
  beforeEach(() => grpcCallMock.mockReset())

  it('sends the filter, page size and cursor as ListExercises fields', async () => {
    grpcCallMock.mockResolvedValue({ exercises: [], nextPageToken: '' })

    await listExercises({ muscleGroupId: 3, search: 'sup', limit: 20, cursor: '40' })

    expect(grpcCallMock.mock.calls[0]?.[1]).toBe('ListExercises')
    expect(grpcCallMock.mock.calls[0]?.[2]).toEqual({ muscleGroupId: 3, search: 'sup', pageSize: 20, pageToken: '40' })
  })

  it('leaves the page size and cursor to upstream defaults when absent', async () => {
    grpcCallMock.mockResolvedValue({ exercises: [], nextPageToken: '' })

    await listExercises()

    expect(grpcCallMock.mock.calls[0]?.[2]).toEqual({ muscleGroupId: 0, search: '', pageSize: 0, pageToken: '' })
  })

  it('maps the upstream token to nextCursor, and an empty one to null', async () => {
    grpcCallMock.mockResolvedValueOnce({ exercises: [row], nextPageToken: '30' })
    grpcCallMock.mockResolvedValueOnce({ exercises: [row], nextPageToken: '' })

    expect(await listExercises()).toEqual({ exercises: [expect.objectContaining({ id: 7 })], nextCursor: '30' })
    expect((await listExercises()).nextCursor).toBeNull()
  })
})
