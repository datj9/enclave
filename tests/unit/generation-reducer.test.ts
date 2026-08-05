import { describe, expect, it } from 'vitest'

import {
  isTerminalAction,
  reducer,
  type GenerationFailure,
  type GenerationResult,
  type GenerationStatus,
  type StreamedFile,
} from '@app/new/use-generation'

/**
 * The pure half of the §5.4 client stream, exercised without rendering the hook —
 * `@testing-library/react` is not installed for this repo.
 */

interface State {
  readonly status: GenerationStatus
  readonly files: readonly StreamedFile[]
  readonly result: GenerationResult | null
  readonly failure: GenerationFailure | null
}

function stateWith(overrides: Partial<State> = {}): State {
  return {
    status: 'streaming',
    files: [],
    result: null,
    failure: null,
    ...overrides,
  }
}

const FILE: StreamedFile = { path: 'index.html', text: '<html></html>', bytes: 14 }
const RESULT: GenerationResult = {
  artifactId: 'artifact_1',
  versionId: 'version_1',
  viewUrl: 'http://example.artifacts.localhost:3000',
}
const FAILURE: GenerationFailure = {
  code: 'NETWORK',
  message: 'The connection to the server was lost',
}

describe('reducer', () => {
  it('keeps files and clears failure on cancelled', () => {
    const state = stateWith({ files: [FILE], failure: FAILURE })

    expect(reducer(state, { type: 'cancelled' })).toEqual({
      ...state,
      status: 'cancelled',
      failure: null,
    })
  })

  it('sets status done and the result on done', () => {
    const state = stateWith({ files: [FILE] })

    expect(reducer(state, { type: 'done', result: RESULT })).toEqual({
      ...state,
      status: 'done',
      result: RESULT,
    })
  })

  it('sets the failure on error', () => {
    const state = stateWith({ files: [FILE] })

    expect(reducer(state, { type: 'error', failure: FAILURE })).toEqual({
      ...state,
      status: 'error',
      failure: FAILURE,
    })
  })
})

describe('isTerminalAction', () => {
  it('is true for done and error', () => {
    expect(isTerminalAction({ type: 'done', result: RESULT })).toBe(true)
    expect(isTerminalAction({ type: 'error', failure: FAILURE })).toBe(true)
  })

  it('is false for every non-terminal action, including cancelled', () => {
    expect(isTerminalAction({ type: 'start' })).toBe(false)
    expect(isTerminalAction({ type: 'file_start', path: 'index.html' })).toBe(false)
    expect(isTerminalAction({ type: 'chunk', path: 'index.html', text: '<' })).toBe(false)
    expect(isTerminalAction({ type: 'file_end', path: 'index.html', bytes: 14 })).toBe(false)
    expect(isTerminalAction({ type: 'cancelled' })).toBe(false)
  })
})
