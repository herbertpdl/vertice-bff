import { isIPv4, isIPv6 } from 'node:net'

/** Every non-address input (empty, garbage, overlong) shares this one key: it can't mint keys. */
export const INVALID_IP_KEY = 'invalid'

/** Longest textual IPv6 (45 chars, IPv4 tail included) plus room for a zone id. */
const MAX_IP_TEXT_LENGTH = 64

type Parsed = { v4: string } | { v6: number[] } | null

/**
 * The rate-limit key for a client address. IPv4 is used as is. IPv6 is cut to its /64: a single
 * subscriber usually gets a whole /64 (or more), so keying full addresses would hand an attacker
 * 2^64 fresh buckets. IPv4-mapped (`::ffff:1.2.3.4`, `::ffff:102:304`) and IPv4-compatible
 * (`::1.2.3.4`) IPv6 count as the IPv4 address. Anything that isn't an address is
 * {@link INVALID_IP_KEY}, so the key never grows with the input.
 */
export function clientIpKey(ip: string): string {
  const parsed = parse(ip)
  if (!parsed) return INVALID_IP_KEY
  if ('v4' in parsed) return parsed.v4
  return `${hex(parsed.v6.slice(0, 4))}::/64`
}

/**
 * The network a client address belongs to, for the coarse aggregate bucket: IPv6 by /48 (a
 * typical end-site allocation, which holds 65,536 /64s) and IPv4 by /24.
 */
export function clientNetworkKey(ip: string): string {
  const parsed = parse(ip)
  if (!parsed) return INVALID_IP_KEY
  if ('v4' in parsed) return `${parsed.v4.split('.').slice(0, 3).join('.')}.0/24`
  return `${hex(parsed.v6.slice(0, 3))}::/48`
}

function parse(ip: string): Parsed {
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > MAX_IP_TEXT_LENGTH) return null
  const address = ip.split('%')[0]! // drop an IPv6 zone id
  if (isIPv4(address)) return { v4: address }
  if (!isIPv6(address)) return null
  const groups = expandIPv6(address)
  const embeddedV4 = () => `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`
  const zeroHead = groups.slice(0, 5).every((g) => g === 0)
  // IPv4-mapped ::ffff:a.b.c.d, in either notation.
  if (zeroHead && groups[5] === 0xffff) return { v4: embeddedV4() }
  // Deprecated IPv4-compatible ::a.b.c.d (but not :: or ::1).
  if (zeroHead && groups[5] === 0 && (groups[6]! > 0 || groups[7]! > 1)) return { v4: embeddedV4() }
  return { v6: groups }
}

const hex = (groups: number[]) => groups.map((g) => g.toString(16)).join(':')

/** The 8 16-bit groups of a valid IPv6 address. */
function expandIPv6(address: string): number[] {
  let text = address.toLowerCase()
  // An embedded IPv4 tail (e.g. `64:ff9b::1.2.3.4`) is the last two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined]
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : Array<string>(8 - headParts.length - tailParts.length).fill('0')
  return [...headParts, ...zeros, ...tailParts].map((part) => parseInt(part, 16) || 0)
}
