import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Not found · enclave' }

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        alignContent: 'center',
        padding: 'var(--space-xl) var(--space-md)',
        maxWidth: '65ch',
        marginInline: 'auto',
      }}
    >
      <h1 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2xs)' }}>Not found</h1>
      <p style={{ color: 'var(--color-ink-2)', margin: 0 }}>
        This page does not exist, or you are not allowed to see that it does.
      </p>
    </main>
  )
}
