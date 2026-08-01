import { and, eq, ne } from 'drizzle-orm'

import { db } from '@/db'
import { userProviderKeys } from '@/db/schema/user-provider-keys'
import { DecryptionError, decryptKey, encryptKey } from '@/lib/crypto/envelope'
import { HttpError } from '@/lib/http'
import type { ProviderId } from './types'
import type { UserProviderKeys } from './index'

/**
 * Reads and writes `user_provider_keys`, sealing on the way in and opening on the way out. This
 * is the only module that turns a stored blob back into a usable key; everything above it sees
 * either a `UserProviderKeys` map bound straight for the provider SDK, or a `last4`.
 *
 * A user holds at most one key. The table is keyed `(user_id, provider)` per §5.2, but storing a
 * second provider's key would silently change which provider runs — `selectProvider` prefers
 * anthropic — so a save replaces whatever was there.
 */

const LAST4_LENGTH = 4

const UNREADABLE_KEY_MESSAGE =
  'Your stored provider key could not be read. Replace it in settings, or delete it to fall back to the instance key.'

export interface StoredProviderKeyView {
  readonly provider: ProviderId
  /** `null` only when the stored blob no longer opens — a rotated `ENCRYPTION_KEY`, say. */
  readonly last4: string | null
  readonly createdAt: string
}

/** The user's own keys for `resolveProviderForUser`. Empty when they have none stored. */
export async function loadUserProviderKeys(userId: string): Promise<UserProviderKeys> {
  const rows = await db
    .select({ provider: userProviderKeys.provider, encryptedKey: userProviderKeys.encryptedKey })
    .from(userProviderKeys)
    .where(eq(userProviderKeys.userId, userId))

  const keys: Partial<Record<ProviderId, string>> = {}
  for (const row of rows) {
    try {
      keys[row.provider] = decryptKey(row.encryptedKey)
    } catch (error) {
      // Left in place deliberately: the user is the only one who can correct it, and deleting
      // their key on a read would silently move them onto the instance key and its lower quota.
      if (error instanceof DecryptionError) {
        throw new HttpError('PROVIDER_KEY_INVALID', UNREADABLE_KEY_MESSAGE)
      }
      throw error
    }
  }
  return keys
}

function last4Of(encryptedKey: Buffer): string | null {
  try {
    return decryptKey(encryptedKey).slice(-LAST4_LENGTH)
  } catch {
    return null
  }
}

export async function getStoredProviderKey(userId: string): Promise<StoredProviderKeyView | null> {
  const [row] = await db
    .select()
    .from(userProviderKeys)
    .where(eq(userProviderKeys.userId, userId))
    .limit(1)

  if (row === undefined) return null
  return {
    provider: row.provider,
    last4: last4Of(row.encryptedKey),
    createdAt: row.createdAt.toISOString(),
  }
}

export async function storeUserProviderKey(
  userId: string,
  provider: ProviderId,
  apiKey: string,
): Promise<void> {
  const encryptedKey = encryptKey(apiKey)

  await db
    .insert(userProviderKeys)
    .values({ userId, provider, encryptedKey })
    .onConflictDoUpdate({
      target: [userProviderKeys.userId, userProviderKeys.provider],
      set: { encryptedKey, createdAt: new Date() },
    })

  await db
    .delete(userProviderKeys)
    .where(and(eq(userProviderKeys.userId, userId), ne(userProviderKeys.provider, provider)))
}

/** Falls the user back to the instance key, and with it the stricter daily quota. */
export async function deleteUserProviderKeys(userId: string): Promise<void> {
  await db.delete(userProviderKeys).where(eq(userProviderKeys.userId, userId))
}
