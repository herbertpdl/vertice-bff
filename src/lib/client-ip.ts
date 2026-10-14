import { isIPv4, isIPv6 } from 'node:net'

/**
 * The rate-limit key for a client address. IPv4 is used as is. IPv6 is cut to its /64: a single
 * subscriber usually gets a whole /64 (or more), so keying full addresses would hand an attacker
 * 2^64 fresh buckets. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) counts as the IPv4 address.
 */
export function clientIpKey(ip: string): string {
  const address = ip.split('%')[0]! // drop an IPv6 zone id
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!
  if (!isIPv6(address)) return address
  return `${expandIPv6(address).slice(0, 4).join(':')}::/64`
}

/** The 8 hextets of a valid IPv6 address, lower-case without leading zeros. */
function expandIPv6(address: string): string[] {
  let text = address.toLowerCase()
  // An embedded IPv4 tail (e.g. `64:ff9b::1.2.3.4`) is the last two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined]
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : Array(8 - headParts.length - tailParts.length).fill('0')
  return [...headParts, ...zeros, ...tailParts].map((part) => (parseInt(part, 16) || 0).toString(16))
}
