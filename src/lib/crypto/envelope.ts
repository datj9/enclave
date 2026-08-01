import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { env } from '@/env'

/**
 * AES-256-GCM sealing for `user_provider_keys.encrypted_key` (§8, A.10.1.1).
 *
 * Layout: `iv (12) || ciphertext || authTag (16)`. GCM authenticates the whole blob, so a
 * tampered or truncated value fails to open instead of decrypting to garbage.
 *
 * Nothing in this module logs, and no caller may log its input or output.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * `ENCRYPTION_KEY` is an operator-supplied passphrase of arbitrary length (§5.7 only requires 32
 * bytes), while AES-256 needs exactly 32. SHA-256 fixes the width without weakening a key that
 * was already generated with `openssl rand`.
 */
function encryptionKey(): Buffer {
  return createHash('sha256').update(env.ENCRYPTION_KEY, 'utf8').digest()
}

export function encryptKey(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, sealed, cipher.getAuthTag()])
}

export class DecryptionError extends Error {
  constructor() {
    super('The stored value could not be decrypted')
    this.name = 'DecryptionError'
  }
}

/** Throws `DecryptionError` for a tampered, truncated, or foreign-key-sealed buffer. */
export function decryptKey(ciphertext: Buffer): string {
  if (ciphertext.length <= IV_BYTES + AUTH_TAG_BYTES) throw new DecryptionError()

  const iv = ciphertext.subarray(0, IV_BYTES)
  const sealed = ciphertext.subarray(IV_BYTES, ciphertext.length - AUTH_TAG_BYTES)
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_BYTES)

  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8')
  } catch {
    // The underlying message is "unsupported state or unable to authenticate data", which says
    // nothing useful and risks being logged with the buffer that produced it.
    throw new DecryptionError()
  }
}
