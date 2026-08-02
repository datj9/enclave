import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONTENT_TYPE_BY_EXTENSION, ENTRY_PATH } from '../../src/lib/bundle/rules.ts'
import { collectBundle } from './src/collect.ts'

describe('collectBundle', () => {
  let directory: string

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps an allowed html and js file', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'app.js'), 'console.log(1)')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['app.js', 'index.html'])
    expect(skipped).toEqual([])
  })

  it('skips an unsupported extension', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'app.js.map'), '{}')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'app.js.map', reason: 'unsupported_extension' })
  })

  it('skips a dotfile', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, '.env'), 'SECRET=1')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: '.env', reason: 'ignored' })
  })

  it('skips node_modules', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    mkdirSync(join(directory, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(
      join(directory, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => {}',
    )

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'node_modules', reason: 'ignored' })
  })

  it('skips a path containing a space', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'my file.html'), '<!doctype html>')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'my file.html', reason: 'invalid_path' })
  })

  it('skips a symlink without following it', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    symlinkSync('index.html', join(directory, 'link.html'))

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'link.html', reason: 'ignored' })
  })

  it('skips a file over the size cap', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'big.png'), Buffer.alloc(2_097_153))

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'big.png', reason: 'too_large' })
  })

  it('respects .enclaveignore', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'draft.html'), '<!doctype html>')
    writeFileSync(join(directory, '.enclaveignore'), 'draft.html')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'draft.html', reason: 'ignored' })
  })

  it('enclaveignore glob matches within a segment', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'a.map'), '{}')
    writeFileSync(join(directory, '.enclaveignore'), '*.map')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toEqual(['index.html'])
    expect(skipped).toContainEqual({ path: 'a.map', reason: 'ignored' })
  })

  it('returns nested paths with forward slashes', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    mkdirSync(join(directory, 'assets'), { recursive: true })
    writeFileSync(join(directory, 'assets', 'app.css'), 'body {}')

    const { files, skipped } = collectBundle(directory)
    expect(files.map((file) => file.path)).toContain('assets/app.css')
    expect(skipped).toEqual([])
  })

  it('returns empty for an empty directory', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))

    const { files, skipped } = collectBundle(directory)
    expect(files).toEqual([])
    expect(skipped).toEqual([])
  })

  it('reads binary content without corruption', () => {
    directory = mkdtempSync(join(tmpdir(), 'collect-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const { files, skipped } = collectBundle(directory)
    const logo = files.find((file) => file.path === 'logo.png')
    expect(logo?.content).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(skipped).toEqual([])
  })
})

/**
 * The CLI classifies files so a push does not waste an upload, but the server is authoritative.
 * A client that accepted MORE than the server is the failure that matters, so these assert the
 * two agree by construction — both now read `src/lib/bundle/rules.ts`. If someone reintroduces a
 * local allowlist in collect.ts, the first test here fails.
 */
describe('the client allowlist is the server allowlist', () => {
  it('accepts every extension the server has a content type for', () => {
    const directory = mkdtempSync(join(tmpdir(), 'enclave-parity-'))
    try {
      writeFileSync(join(directory, ENTRY_PATH), '<!doctype html>')
      const extensions = Object.keys(CONTENT_TYPE_BY_EXTENSION)
      for (const extension of extensions) writeFileSync(join(directory, `asset.${extension}`), 'x')

      const { files, skipped } = collectBundle(directory)

      expect(skipped).toEqual([])
      expect(files).toHaveLength(extensions.length + 1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects an extension the server has no content type for', () => {
    const directory = mkdtempSync(join(tmpdir(), 'enclave-parity-'))
    try {
      writeFileSync(join(directory, ENTRY_PATH), '<!doctype html>')
      for (const name of ['app.js.map', 'icon.ico', 'font.ttf', 'archive.zip']) {
        writeFileSync(join(directory, name), 'x')
      }

      const { skipped } = collectBundle(directory)

      expect(skipped.map((file) => file.reason)).toEqual(
        Array.from({ length: 4 }, () => 'unsupported_extension'),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
