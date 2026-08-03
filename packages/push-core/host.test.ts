import { describe, expect, it } from 'vitest'

import { InvalidHostError, normaliseHost } from './src/host.ts'

describe('normaliseHost', () => {
  const acceptedCases: ReadonlyArray<readonly [string, string]> = [
    ['enclave.example.com', 'https://enclave.example.com'],
    ['enclave.example.com:8443', 'https://enclave.example.com:8443'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['https://enclave.example.com', 'https://enclave.example.com'],
    ['https://enclave.example.com/', 'https://enclave.example.com'],
    ['ENCLAVE.EXAMPLE.COM', 'https://enclave.example.com'],
    ['HTTP://Localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['https://192.168.1.5:3000', 'https://192.168.1.5:3000'],
    ['https://example.com:443', 'https://example.com'],
    ['enclave.example.com/', 'https://enclave.example.com'],
    ['Enclave.Example.COM', 'https://enclave.example.com'],
    ['enclave.example.com:443', 'https://enclave.example.com'],
    ['example.com.', 'https://example.com'],
    ['http://127.0.0.2:3000', 'http://127.0.0.2:3000'],
    ['http://127.9.9.9', 'http://127.9.9.9'],
  ]

  it.each(acceptedCases)('normalises %s to %s', (input, expected) => {
    expect(normaliseHost(input)).toBe(expected)
  })

  const rejectedCases: readonly string[] = [
    '',
    '   ',
    'ftp://example.com',
    'http://user:pw@example.com',
    'not a host',
    'http://',
    'http://enclave.example.com',
    'http://localhost:3000/settings/tokens',
    'enclave.example.com?token=abc',
    'https://enclave.example.com#fragment',
  ]

  it.each(rejectedCases)('throws InvalidHostError for %j', (input) => {
    expect(() => normaliseHost(input)).toThrow(InvalidHostError)
  })

  it('accepts an explicit http scheme to a remote host when insecure is allowed', () => {
    expect(normaliseHost('http://enclave.example.com', true)).toBe('http://enclave.example.com')
  })

  it('never requires the insecure flag for loopback hosts', () => {
    expect(normaliseHost('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normaliseHost('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('rejects an explicit http scheme to a private LAN host without the insecure flag', () => {
    expect(() => normaliseHost('http://192.168.1.5:3000')).toThrow(InvalidHostError)
    expect(normaliseHost('http://192.168.1.5:3000', true)).toBe('http://192.168.1.5:3000')
  })

  it('rejects control characters instead of letting URL silently strip them', () => {
    expect(() => normaliseHost('http://a\tb')).toThrow(InvalidHostError)
    expect(() => normaliseHost('http://a\rb')).toThrow(InvalidHostError)
    expect(() => normaliseHost('http://a\nb')).toThrow(InvalidHostError)
  })
})
