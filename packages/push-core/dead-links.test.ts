import { describe, expect, it } from 'vitest'

import { findDeadLinks } from './src/dead-links.ts'
import type { BundleFile } from './src/types.ts'

function file(path: string, content: string): BundleFile {
  return { path, content: Buffer.from(content, 'utf8') }
}

describe('findDeadLinks', () => {
  it('reports a link to a file the bundle does not contain', () => {
    expect(
      findDeadLinks([file('index.html', '<a href="missing.html">gone</a>')]),
    ).toEqual([{ from: 'index.html', to: 'missing.html' }])
  })

  it('keeps quiet when the target is in the bundle', () => {
    expect(
      findDeadLinks([
        file('index.html', '<a href="page.html">ok</a>'),
        file('page.html', '<!doctype html>'),
      ]),
    ).toEqual([])
  })

  it('reports one nav repeated across pages once per file, sorted by from', () => {
    expect(
      findDeadLinks([
        file('index.html', '<a href="OLD.html">a</a> <a href="OLD.html">b</a>'),
        file('page.html', '<a href="OLD.html">a</a>'),
      ]),
    ).toEqual([
      { from: 'index.html', to: 'OLD.html' },
      { from: 'page.html', to: 'OLD.html' },
    ])
  })

  it('ignores references the origin will serve elsewhere or not at all', () => {
    const markup = [
      '<a href="#top">top</a>',
      '<a href="https://example.com/x.html">web</a>',
      '<a href="mailto:a@b.c">mail</a>',
      '<a href="//cdn/x.js">cdn</a>',
      '<a href="">none</a>',
    ].join('\n')

    expect(findDeadLinks([file('index.html', markup)])).toEqual([])
  })

  it('strips query and fragment before resolving', () => {
    expect(
      findDeadLinks([
        file('index.html', '<a href="page.html?v=2#s">ok</a>'),
        file('page.html', '<!doctype html>'),
      ]),
    ).toEqual([])
  })

  it('resolves relative to the referring file, so a subdirectory can reach the root', () => {
    const subdirectory = [
      file('docs/a.html', '<a href="../index.html">home</a>'),
      file('index.html', '<!doctype html>'),
    ]
    expect(findDeadLinks(subdirectory)).toEqual([])

    expect(findDeadLinks([file('docs/a.html', '<a href="../nope.html">gone</a>')])).toEqual([
      { from: 'docs/a.html', to: 'nope.html' },
    ])
  })

  it('checks src attributes too', () => {
    expect(findDeadLinks([file('index.html', '<img src="missing.png">')])).toEqual([
      { from: 'index.html', to: 'missing.png' },
    ])
  })

  it('never scans non-html files', () => {
    const script = 'var markup = \'<a href="ghost.html">\';'
    expect(findDeadLinks([file('app.js', script)])).toEqual([])
  })

  it('deduplicates the same reference within one file', () => {
    expect(
      findDeadLinks([
        file('index.html', '<a href="missing.html">a</a> <a href="missing.html">b</a>'),
      ]),
    ).toEqual([{ from: 'index.html', to: 'missing.html' }])
  })

  it('ignores an attribute whose name merely ends in href or src', () => {
    expect(
      findDeadLinks([
        file('index.html', '<div data-href="nope.html"></div><img data-src="late.png">'),
      ]),
    ).toEqual([])
  })

  it('matches attribute names case-insensitively, as html does', () => {
    expect(findDeadLinks([file('index.html', '<a HREF="gone.html">gone</a>')])).toEqual([
      { from: 'index.html', to: 'gone.html' },
    ])
  })

  it('checks xlink:href, which is a real fetch on a <use>', () => {
    expect(
      findDeadLinks([file('index.html', '<svg><use xlink:href="icons.svg#star"/></svg>')]),
    ).toEqual([{ from: 'index.html', to: 'icons.svg' }])
  })

  it('resolves a root-absolute reference against the bundle root, which is what the origin serves', () => {
    expect(findDeadLinks([file('index.html', '<a href="/REPORT.html">r</a>')])).toEqual([
      { from: 'index.html', to: 'REPORT.html' },
    ])
    expect(
      findDeadLinks([
        file('docs/a.html', '<a href="/index.html">home</a>'),
        file('index.html', '<!doctype html>'),
      ]),
    ).toEqual([])
  })

  it('leaves the other leading-slash shapes alone', () => {
    const markup = [
      '<a href="//cdn/x.js">cdn</a>',
      '<a href="/__enter">enter</a>',
      '<a href="/">home</a>',
      '<a href="/docs/">docs</a>',
    ].join('\n')
    expect(findDeadLinks([file('index.html', markup)])).toEqual([])
  })

  it('reports the path the browser would request when a reference walks above the root', () => {
    expect(findDeadLinks([file('docs/a.html', '<a href="../../etc/passwd">x</a>')])).toEqual([
      { from: 'docs/a.html', to: 'etc/passwd' },
    ])
    expect(
      findDeadLinks([
        file('docs/a.html', '<a href="../../index.html">home</a>'),
        file('index.html', '<!doctype html>'),
      ]),
    ).toEqual([])
  })
})