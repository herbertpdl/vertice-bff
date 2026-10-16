import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDays,
  BUSINESS_TIME_ZONE,
  businessDateOf,
  currentWeekStartDate,
  daysBetween,
  todayInBusinessZone,
  weekStartDateOf,
} from './dates.js'

/**
 * The business time zone contract (P2-02, audit XREPO-006 / REL-API-008), mirroring vertice-api's
 * `BusinessTimeZoneIntegrationTest`. Like that test, this one must pass whatever the host's `TZ`:
 * `npm run test:hostile-tz` runs the whole suite again under `TZ=Pacific/Kiritimati` (UTC+14),
 * which is on the other side of the date line from São Paulo, so any leftover dependence on the
 * ambient zone turns into a wrong day here rather than a bug in production.
 *
 * `toFake: ['Date']` pins the clock and leaves the timers alone — nothing here awaits one.
 */
const at = (instant: string) => vi.useFakeTimers({ now: new Date(instant), toFake: ['Date'] })

/** The zone's offset at an instant, as `Intl` resolves it ("GMT-03:00"). */
const offsetAt = (instant: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName')!.value

describe('the business time zone', () => {
  afterEach(() => vi.useRealTimers())

  it('is America/Sao_Paulo', () => {
    expect(BUSINESS_TIME_ZONE).toBe('America/Sao_Paulo')
  })

  describe('today and the week start around local midnight', () => {
    // 2026-10-11 is a Sunday; 2026-10-12 is the Monday after it. Both instants below are that
    // Sunday evening in São Paulo, and the second one is already Monday in UTC — the three hours
    // in which the old `new Date().toISOString().slice(0, 10)` reported tomorrow, which is how a
    // Sunday-evening workout ended up in next week's log.
    it('20:30 on the Sunday is that Sunday, and its week started on the Monday before', () => {
      at('2026-10-11T23:30:00Z')
      expect(todayInBusinessZone()).toBe('2026-10-11')
      expect(currentWeekStartDate()).toBe('2026-10-05')
    })

    it('23:30 on the Sunday is still that Sunday, although UTC has already rolled over to Monday', () => {
      at('2026-10-12T02:30:00Z')
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-12') // what the bug reported
      expect(todayInBusinessZone()).toBe('2026-10-11')
      expect(currentWeekStartDate()).toBe('2026-10-05')
    })

    it('00:30 on the Monday is the Monday, and starts the new week', () => {
      at('2026-10-12T03:30:00Z')
      expect(todayInBusinessZone()).toBe('2026-10-12')
      expect(currentWeekStartDate()).toBe('2026-10-12')
    })

    it('crosses local midnight on the minute, not three hours early', () => {
      at('2026-10-12T02:59:59Z')
      expect(todayInBusinessZone()).toBe('2026-10-11')
      at('2026-10-12T03:00:00Z')
      expect(todayInBusinessZone()).toBe('2026-10-12')
    })
  })

  describe('a DST boundary', () => {
    // Brazil abolished DST in 2019, but the data can hold instants from before that, when the zone
    // ran at -02:00 in the southern summer. Only the zone's rules know that; a hardcoded -03:00
    // puts these on the wrong calendar day.
    it('resolves a pre-2019 summer instant at -02:00', () => {
      expect(offsetAt('2018-01-15T02:30:00Z')).toBe('GMT-02:00')
      // 02:30Z is 00:30 on the 15th at -02:00, but 23:30 on the *14th* at a fixed -03:00.
      expect(businessDateOf('2018-01-15T02:30:00Z')).toBe('2018-01-15')
    })

    it('resolves a pre-2019 winter instant at -03:00', () => {
      expect(offsetAt('2018-06-15T02:30:00Z')).toBe('GMT-03:00')
      expect(businessDateOf('2018-06-15T02:30:00Z')).toBe('2018-06-14')
    })

    it('puts the day and the week start on either side of the 2018-11-04 spring-forward', () => {
      // DST began at midnight on 2018-11-04 (a Sunday), when 00:00 jumped to 01:00.
      expect(offsetAt('2018-11-04T02:00:00Z')).toBe('GMT-03:00') // 23:00 on the 3rd
      expect(offsetAt('2018-11-04T04:00:00Z')).toBe('GMT-02:00') // 02:00 on the 4th
      at('2018-11-04T02:00:00Z')
      expect(todayInBusinessZone()).toBe('2018-11-03')
      expect(currentWeekStartDate()).toBe('2018-10-29')
      // The day the clocks went forward: 02:00Z is 00:00 local, which that day does not exist, so
      // the zone resolves it to 01:00 on the 4th. Either way it is the Sunday, week of the 29th.
      at('2018-11-04T04:00:00Z')
      expect(todayInBusinessZone()).toBe('2018-11-04')
      expect(currentWeekStartDate()).toBe('2018-10-29')
      // And the Monday after it starts the next week, with the zone an hour ahead of before.
      at('2018-11-05T04:00:00Z')
      expect(todayInBusinessZone()).toBe('2018-11-05')
      expect(currentWeekStartDate()).toBe('2018-11-05')
    })

    it('puts the day on either side of the 2019-02-17 fall-back, the last one Brazil observed', () => {
      expect(offsetAt('2019-02-16T20:00:00Z')).toBe('GMT-02:00') // 18:00 on the 16th
      expect(offsetAt('2019-02-17T20:00:00Z')).toBe('GMT-03:00') // 17:00 on the 17th
      expect(businessDateOf('2019-02-17T01:30:00Z')).toBe('2019-02-16') // 23:30, DST's last night
    })
  })

  describe('businessDateOf', () => {
    it('is the local calendar day of an instant, not the UTC one', () => {
      expect(businessDateOf('2026-10-17T01:00:00Z')).toBe('2026-10-16') // 22:00 the evening before
      expect(businessDateOf('2026-10-16T12:00:00Z')).toBe('2026-10-16')
      expect(businessDateOf('2026-01-01T02:00:00Z')).toBe('2025-12-31') // and across a year
    })

    it('takes a Date as well as a string', () => {
      expect(businessDateOf(new Date('2026-10-17T01:00:00Z'))).toBe('2026-10-16')
    })

    it('handles the fractional seconds vertice-api sends', () => {
      expect(businessDateOf('2026-08-26T16:52:17.169082Z')).toBe('2026-08-26')
    })
  })

  describe('weekStartDateOf', () => {
    it('maps every day of one week to its Monday', () => {
      const monday = '2026-10-12'
      const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
      expect(week).toEqual([
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
      ])
      for (const day of week) expect(weekStartDateOf(day)).toBe(monday)
      // The Sunday before belongs to the week before — the one case a 0-indexed getDay() gets wrong.
      expect(weekStartDateOf('2026-10-11')).toBe('2026-10-05')
    })

    it('reaches back into the previous month and year', () => {
      expect(weekStartDateOf('2026-03-01')).toBe('2026-02-23') // a Sunday
      expect(weekStartDateOf('2027-01-01')).toBe('2026-12-28') // a Friday
    })
  })

  describe('addDays', () => {
    it('crosses months, years and a leap day', () => {
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
      expect(addDays('2026-10-12', 0)).toBe('2026-10-12')
    })

    it('steps whole days across a DST boundary, so no week start slips by one', () => {
      // -7 from the Monday after DST began lands on the Monday before, despite the hour in between.
      expect(addDays('2018-11-05', -7)).toBe('2018-10-29')
      expect(addDays('2019-02-18', -7)).toBe('2019-02-11')
    })

    it('walks the 4-week adherence lookback the client overview uses', () => {
      const weeks = Array.from({ length: 4 }, (_, i) => addDays('2018-11-05', -7 * i))
      expect(weeks).toEqual(['2018-11-05', '2018-10-29', '2018-10-22', '2018-10-15'])
      for (const week of weeks) expect(weekStartDateOf(week)).toBe(week)
    })
  })

  describe('daysBetween', () => {
    it('counts whole calendar days, in both directions', () => {
      expect(daysBetween('2026-10-16', '2026-10-16')).toBe(0)
      expect(daysBetween('2026-10-16', '2026-10-31')).toBe(15)
      expect(daysBetween('2026-10-31', '2026-10-16')).toBe(-15)
    })

    it('is 0 for a plan ending today, whatever the hour', () => {
      // The old `Math.ceil((new Date(endDate) - Date.now()) / MS_PER_DAY)` compared a business date
      // against an instant, so "ends today" drifted with the time of day.
      at('2026-10-31T23:00:00Z') // 20:00 local on the 31st
      expect(daysBetween(todayInBusinessZone(), '2026-10-31')).toBe(0)
      at('2026-11-01T02:00:00Z') // 23:00 local, still the 31st
      expect(daysBetween(todayInBusinessZone(), '2026-10-31')).toBe(0)
      at('2026-11-01T03:00:00Z') // 00:00 local on the 1st: the plan ended yesterday
      expect(daysBetween(todayInBusinessZone(), '2026-10-31')).toBe(-1)
    })

    it('counts a DST boundary as whole days too', () => {
      expect(daysBetween('2018-11-03', '2018-11-05')).toBe(2)
      expect(daysBetween('2019-02-16', '2019-02-18')).toBe(2)
    })
  })

  it('does not read the host time zone: the results are the same with TZ swapped under it', () => {
    // A direct check of what `npm run test:hostile-tz` proves for the whole suite. Node re-reads
    // `process.env.TZ` when it changes, so this flips the ambient zone mid-test and restores it.
    const originalTz = process.env.TZ
    at('2026-10-12T02:30:00Z') // 23:30 on Sunday the 11th in São Paulo
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12', 'America/Sao_Paulo']) {
        process.env.TZ = tz
        expect(todayInBusinessZone(), tz).toBe('2026-10-11')
        expect(currentWeekStartDate(), tz).toBe('2026-10-05')
        expect(businessDateOf('2018-01-15T02:30:00Z'), tz).toBe('2018-01-15')
        expect(addDays('2026-10-31', 1), tz).toBe('2026-11-01')
        expect(weekStartDateOf('2026-10-11'), tz).toBe('2026-10-05')
        expect(daysBetween('2026-10-16', '2026-10-31'), tz).toBe(15)
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
  })
})
