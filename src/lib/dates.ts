/** Returns the ISO (YYYY-MM-DD) date of the Monday of the current week, UTC. */
export function currentWeekStartDate(): string {
  const now = new Date()
  const day = now.getUTCDay() // 0 = Sunday
  const diffToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday))
  return monday.toISOString().slice(0, 10)
}
