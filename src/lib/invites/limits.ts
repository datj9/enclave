/**
 * Invite lifetimes. Deliberately import-free so the admin console's client bundle can read them
 * without dragging the Postgres driver in behind `manage.ts`.
 */

export const DEFAULT_INVITE_TTL_HOURS = 72
export const MAX_INVITE_TTL_HOURS = 24 * 30
