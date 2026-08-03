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

function parseState(raw: unknown, path: string): ProjectState {
  if (typeof raw !== 'object' || raw === null) {
    throw new StateError(`${path} is not a valid state file — delete it or fix it by hand`)
  }
  const { host, artifactId, lastPushedVersionNo } = raw as Record<string, unknown>

  if (typeof host !== 'string' || host === '') {
    throw new StateError(`${path} has an invalid or missing host — delete it or fix it by hand`)
  }
  if (typeof artifactId !== 'string' || !UUID_PATTERN.test(artifactId)) {
    throw new StateError(
      `${path} has an invalid or missing artifactId — delete it or fix it by hand`,
    )
  }
  if (
    typeof lastPushedVersionNo !== 'number' ||
    !Number.isInteger(lastPushedVersionNo) ||
    lastPushedVersionNo < 1
  ) {
    throw new StateError(
      `${path} has an invalid or missing lastPushedVersionNo — delete it or fix it by hand`,
    )
  }
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

export function writeState(directory: string, state: ProjectState): void {
  if (state.artifactId === '') {
    throw new StateError('refusing to write .enclave.json without an artifactId')
  }
  writeFileSync(statePath(directory), `${JSON.stringify(state, null, 2)}\n`)
}
