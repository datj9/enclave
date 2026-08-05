'use client'

import { useCallback, useReducer, useRef } from 'react'

/**
 * Client half of the §5.4 stream. `EventSource` cannot POST, so the stream is read off `fetch`
 * and framed here — the format is small and fixed, and a dependency to parse `event:`/`data:`
 * would be larger than the parser.
 */

export interface StreamedFile {
  readonly path: string
  readonly text: string
  readonly bytes: number | null
}

export interface GenerationResult {
  readonly artifactId: string
  readonly versionId: string
  readonly viewUrl: string
}

export interface GenerationFailure {
  readonly code: string
  readonly message: string
}

export type GenerationStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

interface GenerationState {
  readonly status: GenerationStatus
  readonly files: readonly StreamedFile[]
  readonly result: GenerationResult | null
  readonly failure: GenerationFailure | null
}

export type Action =
  | { readonly type: 'start' }
  | { readonly type: 'file_start'; readonly path: string }
  | { readonly type: 'chunk'; readonly path: string; readonly text: string }
  | { readonly type: 'file_end'; readonly path: string; readonly bytes: number }
  | { readonly type: 'done'; readonly result: GenerationResult }
  | { readonly type: 'error'; readonly failure: GenerationFailure }
  | { readonly type: 'cancelled' }

const INITIAL_STATE: GenerationState = {
  status: 'idle',
  files: [],
  result: null,
  failure: null,
}

const NETWORK_FAILURE: GenerationFailure = {
  code: 'NETWORK',
  message: 'The connection to the server was lost',
}

function updateFile(
  files: readonly StreamedFile[],
  path: string,
  change: (file: StreamedFile) => StreamedFile,
): readonly StreamedFile[] {
  return files.map((file) => (file.path === path ? change(file) : file))
}

export function reducer(state: GenerationState, action: Action): GenerationState {
  switch (action.type) {
    case 'start':
      return { status: 'streaming', files: [], result: null, failure: null }
    case 'file_start':
      return { ...state, files: [...state.files, { path: action.path, text: '', bytes: null }] }
    case 'chunk':
      return {
        ...state,
        files: updateFile(state.files, action.path, (file) => ({
          ...file,
          text: file.text + action.text,
        })),
      }
    case 'file_end':
      return {
        ...state,
        files: updateFile(state.files, action.path, (file) => ({ ...file, bytes: action.bytes })),
      }
    case 'done':
      return { ...state, status: 'done', result: action.result }
    case 'error':
      return { ...state, status: 'error', failure: action.failure }
    case 'cancelled':
      return { ...state, status: 'cancelled', failure: null }
  }
}

/** Distinguishes a terminal frame from progress frames so the read loop can latch `reachedEnd`. */
export function isTerminalAction(action: Action): boolean {
  return action.type === 'done' || action.type === 'error'
}

interface SseFrame {
  readonly event: string
  readonly data: Record<string, unknown>
}

function parseFrame(frame: string): SseFrame | undefined {
  const eventLine = frame.split('\n').find((line) => line.startsWith('event: '))
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
  if (eventLine === undefined || dataLine === undefined) return undefined

  try {
    return {
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    }
  } catch {
    return undefined
  }
}

async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) return

    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = parseFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      if (frame !== undefined) yield frame
    }
  }
}

function toAction(frame: SseFrame): Action | undefined {
  const path = String(frame.data.path)
  switch (frame.event) {
    case 'file_start':
      return { type: 'file_start', path }
    case 'chunk':
      return { type: 'chunk', path, text: String(frame.data.text) }
    case 'file_end':
      return { type: 'file_end', path, bytes: Number(frame.data.bytes) }
    case 'done':
      return { type: 'done', result: frame.data as unknown as GenerationResult }
    case 'error':
      return {
        type: 'error',
        failure: { code: String(frame.data.code), message: String(frame.data.message) },
      }
    default:
      return undefined
  }
}

/** A non-streaming failure — the route answered with the §5.3 envelope instead of a stream. */
async function failureFromResponse(response: Response): Promise<GenerationFailure> {
  try {
    const body = (await response.json()) as { error?: GenerationFailure }
    if (body.error !== undefined) return body.error
  } catch {
    // Fall through to the generic message below.
  }
  return NETWORK_FAILURE
}

export function useGeneration() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const wasCancelled = useRef(false)

  const generate = useCallback(async (prompt: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    wasCancelled.current = false
    controller.current = new AbortController()
    dispatch({ type: 'start' })

    try {
      const response = await fetch('/api/v1/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.current.signal,
      })

      if (!response.ok || response.body === null) {
        dispatch({ type: 'error', failure: await failureFromResponse(response) })
        return
      }

      let reachedEnd = false
      for await (const frame of readFrames(response.body)) {
        const action = toAction(frame)
        if (action === undefined) continue
        if (isTerminalAction(action)) reachedEnd = true
        dispatch(action)
      }

      // A stream that stops without `done` or `error` is a dropped connection, not a success.
      if (!reachedEnd) dispatch({ type: 'error', failure: NETWORK_FAILURE })
    } catch {
      // `AbortError` is indistinguishable from a dropped connection by type alone, so the
      // cancel path is told apart with a ref `cancel` sets, not by inspecting the error.
      dispatch(
        wasCancelled.current ? { type: 'cancelled' } : { type: 'error', failure: NETWORK_FAILURE },
      )
    } finally {
      inFlight.current = false
      controller.current = null
    }
  }, [])

  const cancel = useCallback((): void => {
    if (controller.current === null) return
    wasCancelled.current = true
    controller.current.abort()
  }, [])

  return { state, generate, cancel }
}
