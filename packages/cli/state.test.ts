import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { legacyStatePath, readState, StateError, statePath, writeState } from './src/state.ts'

const ARTIFACT_ID = '3f2a91c4-1111-4222-8333-444444444444'

describe('state', () => {
  let workspace: string
  let directory: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'enclave-state-'))
    directory = join(workspace, 'dist')
    mkdirSync(directory)
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('statePath lives inside the pushed directory', () => {
    expect(statePath(directory)).toBe(join(directory, '.enclave.json'))
  })

  it('legacyStatePath sits beside the pushed directory', () => {
    expect(legacyStatePath(directory)).toBe(join(workspace, '.enclave.json'))
  })

  it('readState returns null when no file exists', () => {
    expect(readState(directory)).toBeNull()
  })

  it('round-trips a valid state through write and read', () => {
    writeState(directory, { host: 'https://enclave.example.com', artifactId: ARTIFACT_ID, lastPushedVersionNo: 2 })

    expect(readState(directory)).toEqual({
      host: 'https://enclave.example.com',
      artifactId: ARTIFACT_ID,
      lastPushedVersionNo: 2,
    })
  })

  it('refuses to write state without an artifactId', () => {
    expect(() =>
      writeState(directory, { host: 'https://enclave.example.com', artifactId: '', lastPushedVersionNo: 1 }),
    ).toThrow(StateError)
  })

  it('refuses to write an undefined artifactId, which JSON.stringify would drop silently', () => {
    // This is the exact record that bricked a project directory: `{host, lastPushedVersionNo}`.
    const withoutId = {
      host: 'https://enclave.example.com',
      lastPushedVersionNo: 1,
    } as unknown as Parameters<typeof writeState>[1]

    expect(() => writeState(directory, withoutId)).toThrow(StateError)
    expect(readState(directory)).toBeNull()
  })

  it('refuses to write an artifactId that is not a uuid', () => {
    expect(() =>
      writeState(directory, {
        host: 'https://enclave.example.com',
        artifactId: 'not-a-uuid',
        lastPushedVersionNo: 1,
      }),
    ).toThrow(StateError)
  })

  it('refuses to write a state whose host is missing', () => {
    const withoutHost = {
      artifactId: ARTIFACT_ID,
      lastPushedVersionNo: 1,
    } as unknown as Parameters<typeof writeState>[1]

    expect(() => writeState(directory, withoutHost)).toThrow(StateError)
  })

  it('throws StateError for malformed JSON, not a raw parse error', () => {
    writeFileSync(statePath(directory), '{ not json')

    expect(() => readState(directory)).toThrow(StateError)
  })

  it('throws StateError for a non-uuid artifactId', () => {
    writeFileSync(
      statePath(directory),
      JSON.stringify({ host: 'https://enclave.example.com', artifactId: 'not-a-uuid', lastPushedVersionNo: 1 }),
    )

    expect(() => readState(directory)).toThrow(StateError)
  })

  it('throws StateError for a missing artifactId', () => {
    writeFileSync(
      statePath(directory),
      JSON.stringify({ host: 'https://enclave.example.com', lastPushedVersionNo: 1 }),
    )

    expect(() => readState(directory)).toThrow(StateError)
  })

  it('throws StateError for a non-positive-integer lastPushedVersionNo', () => {
    writeFileSync(
      statePath(directory),
      JSON.stringify({ host: 'https://enclave.example.com', artifactId: ARTIFACT_ID, lastPushedVersionNo: 0 }),
    )

    expect(() => readState(directory)).toThrow(StateError)
  })

  it('throws StateError for a missing host', () => {
    writeFileSync(
      statePath(directory),
      JSON.stringify({ artifactId: ARTIFACT_ID, lastPushedVersionNo: 1 }),
    )

    expect(() => readState(directory)).toThrow(StateError)
  })

  it('throws StateError when the file is not a JSON object', () => {
    writeFileSync(statePath(directory), '"just a string"')

    expect(() => readState(directory)).toThrow(StateError)
  })
})
