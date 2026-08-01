/**
 * The wire format for grill-result §5.4. One place builds an event frame, so the five event names
 * and their payload shapes cannot drift between the route and its tests.
 */

export type SseEventName = 'file_start' | 'chunk' | 'file_end' | 'done' | 'error'

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  // `no-transform` and the nginx hint stop a proxy buffering the stream into one lump.
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
}

const encoder = new TextEncoder()

export function encodeSseEvent(event: SseEventName, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
