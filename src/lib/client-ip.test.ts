import { describe, expect, it } from 'vitest'
import { clientIpKey, clientNetworkKey } from './client-ip.js'

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

describe('clientIpKey bounds', () => {
  it.each([['empty', ''], ['garbage', 'not-an-ip'], ['overlong', '1'.repeat(1_000_000)], ['overlong IPv6-ish', `${'a:'.repeat(40)}1`]])(
    'maps %s input to the fixed invalid key',
    (_why, input) => {
      expect(clientIpKey(input)).toBe('invalid')
      expect(clientNetworkKey(input)).toBe('invalid')
    },
  )

  it('treats the hex IPv4-mapped and the IPv4-compatible forms as IPv4', () => {
    expect(clientIpKey('::ffff:102:304')).toBe('1.2.3.4')
    expect(clientIpKey('::FFFF:0102:0304')).toBe('1.2.3.4')
    expect(clientIpKey('::1.2.3.4')).toBe('1.2.3.4')
    expect(clientIpKey('::1')).toBe('0:0:0:0::/64') // loopback stays IPv6
  })
})

describe('clientNetworkKey', () => {
  it('groups IPv6 by /48 and IPv4 by /24', () => {
    expect(clientNetworkKey('2001:db8:1:2::1')).toBe('2001:db8:1::/48')
    expect(clientNetworkKey('2001:db8:1:ffff::9')).toBe('2001:db8:1::/48')
    expect(clientNetworkKey('203.0.113.7')).toBe('203.0.113.0/24')
    expect(clientNetworkKey('::ffff:203.0.113.7')).toBe('203.0.113.0/24')
  })
})
