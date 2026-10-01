import { describe, expect, it } from 'vitest'
import { toExercise } from './service.js'

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
