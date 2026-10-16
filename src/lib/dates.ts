/**
 * The business time zone and the two kinds of date value (P2-02, audit XREPO-006 / REL-API-008).
 *
 * vertice-api's rule, which this repo mirrors (its README "Dates and times" and CLAUDE.md
 * "Time: instants vs. business dates"; restated for clients in `docs/api-contract.md`):
 *
 * - An **instant** (`startedAt`, `completedAt`, `recordedAt`, `createdAt`, ...) is an absolute point
 *   in time, ISO-8601 with the `Z` designator. The BFF relays it verbatim and never reads a clock
 *   or a calendar day off the string — to get the day, resolve it in the zone (`businessDateOf`);
 *   the clock is the client's to format, so no response field is a pre-formatted local time.
 * - A **business date** (a plan's `startDate`/`endDate`, a log's `weekStartDate`) is a local
 *   calendar day in `America/Sao_Paulo`, `yyyy-MM-dd`, with no time and no zone. Two of them
 *   compare and sort as plain strings; arithmetic on them is calendar arithmetic (`addDays`,
 *   `daysBetween`), never milliseconds against an instant.
 *
 * So "today" and "this week's Monday" are a *business* question and are resolved through `Intl` in
 * `BUSINESS_TIME_ZONE`. `new Date().toISOString().slice(0, 10)` is the UTC day, which flips at
 * 21:00 local and put Sunday-evening workouts in next week's log — that is the bug this replaced.
 *
 * Nothing here depends on the host's `TZ`, and nothing may come to: `npm run test:hostile-tz` runs
 * the whole suite again under `TZ=Pacific/Kiritimati` (UTC+14), as vertice-api's
 * `hostileTimeZoneTest` does for the JVM. There is no fixed `-03:00` either — Brazil observed DST
 * until 2019, so an instant from before then resolves at `-02:00`, which only the zone rules know.
 */

export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * `formatToParts` rather than a formatted string: the parts are the numbers themselves, so no
 * locale's ordering or separators can get into the result.
 */
const businessDayParts = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const pad = (n: number) => String(n).padStart(2, '0')

/** Splits a `yyyy-MM-dd` business date into its three numbers. Assumes a validated string. */
function partsOf(businessDate: string): { year: number; month: number; day: number } {
  const [year, month, day] = businessDate.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

/**
 * Calendar arithmetic on a business date, through `Date.UTC` so it is a pure civil-date
 * computation: the numbers go in and come out, and no zone (the host's least of all) is consulted.
 */
function civilDay(businessDate: string): Date {
  const { year, month, day } = partsOf(businessDate)
  return new Date(Date.UTC(year, month - 1, day))
}

const toBusinessDate = (civil: Date): string =>
  `${civil.getUTCFullYear()}-${pad(civil.getUTCMonth() + 1)}-${pad(civil.getUTCDate())}`

/**
 * The business date an instant falls on — the calendar day a person in São Paulo was living when it
 * happened. This is the only correct way to get a day out of an instant: `isoInstant.slice(0, 10)`
 * is the UTC day, which is tomorrow's from 21:00 local onwards.
 *
 * A string argument must carry `Z` or an explicit offset. A naive `2026-10-11T22:00:00` parses as
 * *host*-local, which is the one way the host's zone could still reach a result here — and the
 * hostile-TZ pass cannot catch it, because such a string never occurs: every instant comes from
 * vertice-api's `Instant.toString()`, which always ends in `Z`. Keep it that way.
 */
export function businessDateOf(instant: Date | string): string {
  const parts = businessDayParts.formatToParts(instant instanceof Date ? instant : new Date(instant))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** Today's business date. */
export function todayInBusinessZone(now: Date = new Date()): string {
  return businessDateOf(now)
}

/**
 * The Monday of the week containing `businessDate` — the `weekStartDate` vertice-api keys workout
 * logs by, which it validates to be a Monday. Pure calendar arithmetic on the civil date, so the
 * host's zone and `Date#getDay()` never enter into it.
 */
export function weekStartDateOf(businessDate: string): string {
  const civil = civilDay(businessDate)
  const dayOfWeek = civil.getUTCDay() // 0 = Sunday
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  return addDays(businessDate, -daysSinceMonday)
}

/** The Monday of the current week, in the business zone. */
export function currentWeekStartDate(now: Date = new Date()): string {
  return weekStartDateOf(todayInBusinessZone(now))
}

/** `businessDate` shifted by whole calendar days (negative goes back). */
export function addDays(businessDate: string, days: number): string {
  return toBusinessDate(new Date(civilDay(businessDate).getTime() + days * MS_PER_DAY))
}

/**
 * Whole calendar days from `from` to `to`, both business dates (negative when `to` is earlier).
 * Counting days between two *dates* rather than milliseconds between an instant and a date is what
 * keeps "ends in 0 days" from meaning "ended" for the rest of the afternoon.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((civilDay(to).getTime() - civilDay(from).getTime()) / MS_PER_DAY)
}
