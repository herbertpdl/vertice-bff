import { describe, expect, it } from 'vitest'
import type { Exercise } from '../exercises/service.js'
import { validateProposal } from './proposal.js'

const exercise = (id: number): Exercise => ({
  id,
  name: `Exercício ${id}`,
  description: '',
  videoUrl: '',
  muscleGroups: [{ id: 1, name: 'Quadríceps' }],
  isStarter: true,
})
const catalog = new Map([1, 2].map((id) => [id, exercise(id)]))
const keys = new Set(['e1', 'e2'])
const check = (raw: unknown) => validateProposal(raw, catalog, keys)

describe('validateProposal', () => {
  it('enriches a valid proposal with each exercise, keeping the keys and the entry fields', () => {
    const result = check({
      exercises: [
        { key: 'e2', exerciseId: 2, restSecondsBetweenSets: 90, sets: [{ reps: 10, weight: '40.5', strategy: 'STRAIGHT' }] },
        { key: null, exerciseId: 1, notes: 'Finalizador', sets: [] },
        { exerciseId: 1 },
      ],
    })
    expect(result).toEqual({
      ok: true,
      proposal: {
        exercises: [
          { key: 'e2', exerciseId: 2, restSecondsBetweenSets: 90, sets: [{ reps: 10, weight: '40.5', strategy: 'STRAIGHT' }], exercise: exercise(2) },
          { key: null, exerciseId: 1, notes: 'Finalizador', sets: [], exercise: exercise(1) },
          { key: null, exerciseId: 1, sets: [], exercise: exercise(1) },
        ],
      },
    })
  })

  it('accepts an empty proposal (every on-screen exercise removed)', () => {
    expect(check({ exercises: [] }).ok).toBe(true)
  })

  it.each([
    ['an id outside the catalog', { exercises: [{ key: null, exerciseId: 3, sets: [] }] }],
    ['21 exercises', { exercises: Array.from({ length: 21 }, () => ({ key: null, exerciseId: 1, sets: [] })) }],
    ['11 sets', { exercises: [{ key: null, exerciseId: 1, sets: Array.from({ length: 11 }, () => ({ reps: 1 })) }] }],
    ['an out-of-range weight', { exercises: [{ key: null, exerciseId: 1, sets: [{ weight: '12345' }] }] }],
    ['out-of-range rest', { exercises: [{ key: null, exerciseId: 1, restSecondsBetweenSets: 3601, sets: [] }] }],
    ['an unknown strategy', { exercises: [{ key: null, exerciseId: 1, sets: [{ strategy: 'SUPERSET' }] }] }],
    ['a workout name', { name: 'Treino novo', exercises: [] }],
    ['a weekday', { dayOfWeek: 'FRIDAY', exercises: [] }],
    ['an extra entry field', { exercises: [{ key: null, exerciseId: 1, sets: [], order: 1 }] }],
    ['an extra set field', { exercises: [{ key: null, exerciseId: 1, sets: [{ reps: 1, setNumber: 1 }] }] }],
    ['a key that was not sent', { exercises: [{ key: 'e9', exerciseId: 1, sets: [] }] }],
    ['a key used twice', { exercises: [{ key: 'e1', exerciseId: 1, sets: [] }, { key: 'e1', exerciseId: 2, sets: [] }] }],
    ['no exercises list', {}],
    ['not an object', 'proposta'],
  ])('refuses %s', (_, raw) => {
    const result = check(raw)
    expect(result.ok).toBe(false)
  })

  it('names field paths, never values, in the reason', () => {
    const result = check({ exercises: [{ key: null, exerciseId: 1, notes: 'segredo'.repeat(50), sets: [] }] })
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.reason).not.toContain('segredo')
  })
})
