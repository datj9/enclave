/**
 * The delete confirmation. Like the `Only me` copy next door, it names a number rather than warning
 * unconditionally — and "live" here is the one definition the product has: `countLiveShareLinks`,
 * which drops expired links as well as revoked ones.
 */

const LEAD = 'It leaves your list and stops opening for everyone, you included.'
const NO_LIVE_LINKS = 'It has no live share links.'

function liveLinkSentence(liveShareLinkCount: number): string {
  if (liveShareLinkCount < 1) return NO_LIVE_LINKS
  return liveShareLinkCount === 1
    ? 'Its 1 live share link stops working immediately, and restoring does not bring it back.'
    : `Its ${liveShareLinkCount} live share links stop working immediately, and restoring does not bring them back.`
}

export function deleteConfirmBody(liveShareLinkCount: number, retentionDays: number): string {
  return `${LEAD} ${liveLinkSentence(liveShareLinkCount)} You have ${retentionDays} days to restore it from the trash before it is erased for good.`
}
