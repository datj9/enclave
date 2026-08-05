import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ProjectState {
  readonly host: string
  readonly artifactId: string
  readonly lastPushedVersionNo: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A state file that exists but cannot be trusted — malformed JSON or a shape that fails validation. */
export class StateError extends Error {}

/** The state file lives inside the pushed directory: a sibling directory must never see it and
 *  collide with another project's own state. */
export function statePath(directory: string): string {
  return join(resolve(directory), '.enclave.json')
}

/** Before this fix, state lived beside the pushed directory. Used only to detect that layout and
 *  tell the user how to move on, never to read from silently. */
export function legacyStatePath(directory: string): string {
  return join(dirname(resolve(directory)), '.enclave.json')
}

/** One validator for both directions, so a record that cannot be read back can never be written. */
function invalidReason(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'it is not a JSON object'
  const { host, artifactId, lastPushedVersionNo } = raw as Record<string, unknown>

  if (typeof host !== 'string' || host === '') return 'the host is missing or invalid'
  if (typeof artifactId !== 'string' || !UUID_PATTERN.test(artifactId)) {
    return 'the artifactId is missing or is not a uuid'
  }
  if (
    typeof lastPushedVersionNo !== 'number' ||
    !Number.isInteger(lastPushedVersionNo) ||
    lastPushedVersionNo < 1
  ) {
    return 'the lastPushedVersionNo is missing or is not a positive integer'
  }
  return null
}

function parseState(raw: unknown, path: string): ProjectState {
  const reason = invalidReason(raw)
  if (reason !== null) {
    throw new StateError(`${path} is unusable — ${reason}. Delete it or fix it by hand`)
  }
  const { host, artifactId, lastPushedVersionNo } = raw as ProjectState
  return { host, artifactId, lastPushedVersionNo }
}

export function readState(directory: string): ProjectState | null {
  const path = statePath(directory)
  if (!existsSync(path)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new StateError(`${path} is not valid JSON — delete it or fix it by hand`)
  }
  return parseState(raw, path)
}

/**
 * The bricked state file that motivated this guard had `artifactId: undefined`, which
 * `JSON.stringify` drops silently — so an `=== ''` test would have written it through unchanged.
 * Validating the whole record is what makes this defence hold the next time a response shape shifts.
 */
export function writeState(directory: string, state: ProjectState): void {
  const path = statePath(directory)
  const reason = invalidReason(state)
  if (reason !== null) throw new StateError(`refusing to write ${path} — ${reason}`)
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}
