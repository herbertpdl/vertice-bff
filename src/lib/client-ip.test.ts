import { describe, expect, it } from 'vitest'
import { clientIpKey } from './client-ip.js'

describe('clientIpKey', () => {
  it('keeps IPv4 as is, including IPv4-mapped IPv6', () => {
    expect(clientIpKey('203.0.113.7')).toBe('203.0.113.7')
    expect(clientIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('keys IPv6 by its /64, so rotating the interface id lands in one bucket', () => {
    const key = '2001:db8:1:2::/64'
    expect(clientIpKey('2001:db8:1:2::1')).toBe(key)
    expect(clientIpKey('2001:0db8:0001:0002:abcd:ef01:2345:6789')).toBe(key)
    expect(clientIpKey('2001:DB8:1:2:ffff::%eth0')).toBe(key)
    expect(clientIpKey('2001:db8:1:3::1')).not.toBe(key)
  })

  it('expands :: anywhere', () => {
    expect(clientIpKey('::1')).toBe('0:0:0:0::/64')
    expect(clientIpKey('2001:db8::')).toBe('2001:db8:0:0::/64')
    expect(clientIpKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64')
  })
})
