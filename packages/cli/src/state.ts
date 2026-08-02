import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ProjectState {
  readonly host: string
  readonly artifactId: string
  readonly lastPushedVersionNo: number
}

/** The state file sits beside the pushed directory: a `dist/` is generated and wiped. */
export function statePath(directory: string): string {
  return join(dirname(resolve(directory)), '.enclave.json')
}

export function readState(directory: string): ProjectState | null {
  const path = statePath(directory)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ProjectState
}

export function writeState(directory: string, state: ProjectState): void {
  writeFileSync(statePath(directory), `${JSON.stringify(state, null, 2)}\n`)
}
