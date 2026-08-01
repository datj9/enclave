/**
 * Decision #25 made visible. Invite-only is the default precisely because "visible to the
 * organization" is only a meaningful boundary while joining the organization is controlled — with
 * open registration on, an org-visible artifact is readable by anyone who fills in the signup form.
 *
 * The console says so on every admin page rather than burying it in settings: the operator who
 * flipped the flag is not necessarily the one deciding an artifact's visibility later.
 */

export const OPEN_REGISTRATION_WARNING =
  'Open registration is on: anyone who signs up can read every artifact set to Organization. ' +
  'Set ALLOW_OPEN_REGISTRATION=false to return to invite-only.'

export const INVITE_ONLY_NOTICE =
  'Invite-only. /signup answers 404 without a live invite, so Organization means the people you invited.'

export function registrationModeLabel(isOpenRegistration: boolean): string {
  return isOpenRegistration ? 'open' : 'invite-only'
}

/** `null` when the instance is invite-only — there is nothing to warn about. */
export function openRegistrationWarning(isOpenRegistration: boolean): string | null {
  return isOpenRegistration ? OPEN_REGISTRATION_WARNING : null
}
