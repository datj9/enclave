import { describe, expect, it } from 'vitest'

import { DecryptionError, decryptKey, encryptKey } from '@/lib/crypto/envelope'

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const API_KEY = 'sk-ant-api03-not-a-real-key-0123456789'

describe('encryptKey / decryptKey', () => {
  it('round-trips a provider key', () => {
    expect(decryptKey(encryptKey(API_KEY))).toBe(API_KEY)
  })

  it('round-trips a key with multi-byte characters', () => {
    const unicodeKey = 'sk-täst-🔐-0123456789'
    expect(decryptKey(encryptKey(unicodeKey))).toBe(unicodeKey)
  })

  it('never stores the plaintext in the sealed buffer', () => {
    expect(encryptKey(API_KEY).toString('utf8')).not.toContain('sk-ant')
  })

  it('produces a different blob every time, so equal keys are not linkable', () => {
    const first = encryptKey(API_KEY)
    const second = encryptKey(API_KEY)

    expect(first.equals(second)).toBe(false)
    expect(first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES))).toBe(false)
  })

  it('lays out iv, ciphertext and auth tag in that order', () => {
    const sealed = encryptKey(API_KEY)
    expect(sealed).toHaveLength(IV_BYTES + Buffer.byteLength(API_KEY, 'utf8') + AUTH_TAG_BYTES)
  })

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const sealed = encryptKey(API_KEY)
    const tampered = Buffer.from(sealed)
    const middle = IV_BYTES + 3
    tampered[middle] = (tampered[middle] ?? 0) ^ 0xff

    expect(() => decryptKey(tampered)).toThrow(DecryptionError)
  })

  it('rejects a tampered auth tag', () => {
    const sealed = encryptKey(API_KEY)
    const tampered = Buffer.from(sealed)
    const lastIndex = tampered.length - 1
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0x01

    expect(() => decryptKey(tampered)).toThrow(DecryptionError)
  })

  it('rejects a tampered iv', () => {
    const sealed = encryptKey(API_KEY)
    const tampered = Buffer.from(sealed)
    tampered[0] = (tampered[0] ?? 0) ^ 0x01

    expect(() => decryptKey(tampered)).toThrow(DecryptionError)
  })

  it('rejects a buffer too short to hold an iv and a tag', () => {
    expect(() => decryptKey(Buffer.alloc(IV_BYTES + AUTH_TAG_BYTES))).toThrow(DecryptionError)
    expect(() => decryptKey(Buffer.alloc(0))).toThrow(DecryptionError)
  })

  it('rejects a truncated ciphertext', () => {
    const sealed = encryptKey(API_KEY)
    expect(() => decryptKey(sealed.subarray(0, sealed.length - 4))).toThrow(DecryptionError)
  })
})
