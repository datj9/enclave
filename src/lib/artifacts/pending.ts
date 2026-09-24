/**
 * How long a `pending` version may sit before it counts as abandoned. The sweeper reclaims
 * versions older than this, and `appendVersion` stops treating them as an append still in flight
 * — one number, so the two can never disagree about which uploads are dead.
 */
export const PENDING_SWEEP_AFTER_MINUTES = 15
