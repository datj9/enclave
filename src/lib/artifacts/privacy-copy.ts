/**
 * The `Only me` copy. It names a number rather than warning unconditionally: an owner with no
 * links must not be told to revoke links that do not exist.
 *
 * "Still opens it" is the honest verb — setting an artifact to `private` stops people browsing to
 * it and does nothing else. Revoking is the only thing that closes a link (`canRead` branch 4).
 */

const NOBODY_CAN_BROWSE = 'Nobody can browse to it.'

export function privateHint(liveShareLinkCount: number): string {
  if (liveShareLinkCount < 1) return NOBODY_CAN_BROWSE
  return liveShareLinkCount === 1
    ? `${NOBODY_CAN_BROWSE} 1 share link still opens it — revoke it in Share.`
    : `${NOBODY_CAN_BROWSE} ${liveShareLinkCount} share links still open it — revoke them in Share.`
}

export function privateConfirmBody(liveShareLinkCount: number): string {
  return liveShareLinkCount === 1
    ? '1 share link still opens this artifact. Setting it to Only me does not close it — revoke it in Share.'
    : `${liveShareLinkCount} share links still open this artifact. Setting it to Only me does not close them — revoke them in Share.`
}
