import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { grpcCall } from '../../grpc/call.js'
import { bearer, fakeGrpcCall, ids } from '../../test/fakeUpstream.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

/**
 * The business time zone through `GET /dashboard` (P2-02, audit XREPO-006 / REL-API-008). The
 * fixtures put the clock at 23:30 on Sunday 2026-10-11 in São Paulo, which is already Monday the
 * 12th in UTC — the three hours a day in which the old UTC-derived "today" was wrong. Everything
 * here is about which day a completion belongs to and what the route says about it; the pure date
 * arithmetic is covered in `src/lib/dates.test.ts`.
 */
const SUNDAY_2330_LOCAL = '2026-10-12T02:30:00Z'
/** 22:00 on that same Sunday: an evening workout, and the case the bug got visibly wrong. */
const SUNDAY_2200_LOCAL = '2026-10-12T01:00:00Z'

/** Answers `ListWorkoutLogs` with client A's log, completed at `completedAt`. */
function withCompletedLog(completedAt: string) {
  grpcCallMock.mockImplementation(async (client, method, request, options) => {
    const res = await fakeGrpcCall(client, method, request, options)
    if (method !== 'ListWorkoutLogs') return res as never
    const { workoutLogs } = res as unknown as { workoutLogs: { clientId: string }[] }
    return { workoutLogs: workoutLogs.map((log) => ({ ...log, completedAt })) } as never
  })
}

describe('GET /dashboard', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
  })
  afterEach(() => vi.useRealTimers())

  // Only `Date` is faked: the timers stay real, so `app.inject` is not waiting on a frozen clock.
  const at = (instant: string) => vi.useFakeTimers({ now: new Date(instant), toFake: ['Date'] })
  const get = () => app.inject({ method: 'GET', url: '/api/dashboard', headers: bearer('trainerA') })

  it('counts a Sunday-evening completion as that Sunday, although UTC is already on Monday', async () => {
    at(SUNDAY_2330_LOCAL)
    withCompletedLog(SUNDAY_2200_LOCAL)
    const res = await get()
    expect(res.statusCode, res.body).toBe(200)
    // The old `completedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)` compared the
    // log's UTC day (the 12th) with the request's UTC day (also the 12th) and, by coincidence of
    // both being shifted, still listed it — but a 20:00 completion (23:00Z on the 11th) would
    // have been dropped. That case is the next test.
    expect(res.json().completedToday).toEqual([
      { student: 'Client A', workout: `Workout ${ids.workoutA}`, time: '22:00', completedAt: SUNDAY_2200_LOCAL },
    ])
  })

  it('counts a completion whose UTC day is yesterday but whose local day is today', async () => {
    at('2026-10-11T23:50:00Z') // 20:50 local on Sunday the 11th
    withCompletedLog('2026-10-11T22:00:00Z') // 19:00 local, same Sunday; UTC day is the 11th too
    expect((await get()).json().completedToday).toHaveLength(1)

    // Now the request comes in after local midnight: the same completion is yesterday's.
    at('2026-10-12T03:30:00Z') // 00:30 local on Monday the 12th
    expect((await get()).json().completedToday).toEqual([])
  })

  it('drops a completion from the previous local day even when UTC still calls it today', async () => {
    at('2026-10-12T23:00:00Z') // 20:00 local on Monday the 12th
    withCompletedLog('2026-10-12T02:00:00Z') // 23:00 local on Sunday the 11th — not today
    expect((await get()).json().completedToday).toEqual([])
  })

  it('answers the business-zone clock in the deprecated `time`, and the instant in `completedAt`', async () => {
    at(SUNDAY_2330_LOCAL)
    withCompletedLog(SUNDAY_2200_LOCAL)
    const [entry] = (await get()).json().completedToday as { time: string; completedAt: string }[]
    // `time: completedAt.slice(11, 16)` used to answer "01:00" here — the UTC wall clock shown as
    // if it were local, i.e. an evening workout displayed three hours early. It is now the clock
    // the trainer actually read in São Paulo. The field stays (deprecated) so the web build in
    // production keeps working until it switches to `completedAt`.
    expect(entry!.time).toBe('22:00')
    expect(entry!.completedAt).toBe(SUNDAY_2200_LOCAL)
    // Which is exactly what a client formatting the instant itself arrives at.
    expect(
      new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(entry!.completedAt)),
    ).toBe('22:00')
  })

  it('formats `time` past local midnight as 00:xx, not 24:xx', async () => {
    at('2026-10-12T04:00:00Z') // 01:00 local on Monday the 12th
    withCompletedLog('2026-10-12T03:10:00Z') // 00:10 local, same Monday
    const [entry] = (await get()).json().completedToday as { time: string }[]
    expect(entry!.time).toBe('00:10')
  })

  it('counts a plan ending today as 0 days left, not as expired, late in the local day', async () => {
    at('2026-10-12T02:30:00Z')
    grpcCallMock.mockImplementation(async (client, method, request, options) => {
      const res = await fakeGrpcCall(client, method, request, options)
      if (method !== 'ListTrainingPlans') return res as never
      const { trainingPlans } = res as unknown as { trainingPlans: { id: string }[] }
      // Every plan ends on the local day the clock is pinned to.
      return { trainingPlans: trainingPlans.map((p) => ({ ...p, endDate: '2026-10-11' })) } as never
    })
    const dashboard = (await get()).json()
    // Trainer A has three plans in the fixtures, all of them now ending on the local today.
    expect(dashboard.expiringPlans.map((p: { daysLeft: number }) => p.daysLeft)).toEqual([0, 0, 0])
    expect(dashboard.stats.activePlans).toBe(3) // startDate <= today <= endDate, in the local day
  })
})
