import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import type { Entry } from './journal'
import { clock, environment, fence, readLogTail, reportArchive, reportFileName, reportMarkdown, type ReportData } from './report'

const dir = mkdtempSync(join(tmpdir(), 'tmd-report-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const at = new Date(2026, 8, 11, 10, 42, 13).getTime()
const entry = (seconds: number, kind: Entry['kind'], text: string, extra: Partial<Entry> = {}): Entry => ({
  t: at - seconds * 1000,
  kind,
  text,
  ...extra
})

function data(overrides: Partial<ReportData> = {}): ReportData {
  return {
    label: 'Modly · dev',
    source: { source: 'lightningpixel/modly · dev', commit: '0123456789abcdef0123' },
    at,
    environment: ['System: Windows 11 Pro 10.0.26200 (x64)', 'GPU: NVIDIA GeForce RTX 5070'],
    journal: {
      timeline: [
        entry(40, 'navigation', 'Went to file:///~/app/index.html#/generate'),
        entry(30, 'action', 'Clicked button "Generate"', { count: 2 }),
        entry(20, 'error', 'Console error: TypeError: mesh is undefined')
      ],
      errors: [
        entry(20, 'error', 'Console error: TypeError: mesh is undefined', { detail: 'TypeError: mesh is undefined\n    at load (viewer.js:12)' }),
        entry(300, 'crash', 'The page\'s process is gone: oom (exit code 1)')
      ],
      warnings: [entry(25, 'warning', 'Console warning: <Canvas> is deprecated')]
    },
    log: ['[FastAPI] started', '[FastAPI] ERROR: CUDA out of memory'],
    ...overrides
  }
}

describe('reportMarkdown', () => {
  it('puts the description, the error, the steps, the environment and the log in that order', () => {
    const md = reportMarkdown(data(), '  I clicked Generate twice and the viewer stayed empty.  ')
    const order = ['# Bug report: Modly · dev', '## What happened', 'I clicked Generate twice', '## Error', '## Warnings (1)', '## Steps (last 10 minutes)', '## Environment', '## Log']
    let from = -1
    for (const heading of order) {
      const index = md.indexOf(heading)
      assert.ok(index > from, `${heading} comes next`)
      from = index
    }
    assert.match(md, /\*\*10:41:53\*\* Console error: TypeError: mesh is undefined\n\n```text\nTypeError: mesh is undefined\n {4}at load \(viewer\.js:12\)\n```/)
    assert.match(md, /Earlier errors:\n\n- 10:37:13 The page's process is gone: oom \(exit code 1\)/)
    assert.match(md, /- 10:41:43 Clicked button "Generate" \(×2\)/)
    assert.match(md, /- 10:41:53 \*\*Error\*\* Console error/)
    assert.match(md, /- 10:41:48 Console warning: \\<Canvas> is deprecated/)
    assert.match(md, /- Source: lightningpixel\/modly · dev · commit 0123456789ab\n/)
    assert.match(md, /- GPU: NVIDIA GeForce RTX 5070/)
    assert.match(md, /Last 2 lines\.\n\n```text\n\[FastAPI\] started\n\[FastAPI\] ERROR: CUDA out of memory\n```/)
    assert.match(md, /read the report before sending it/)
  })

  it('says so when nothing was described, recorded or logged', () => {
    const md = reportMarkdown(data({ journal: { timeline: [], errors: [], warnings: [] }, log: [], source: undefined }), '')
    assert.match(md, /_No description given\._/)
    assert.match(md, /No error was recorded in the application/)
    assert.match(md, /_Nothing was recorded in the last 10 minutes\._/)
    assert.ok(!md.includes('## Log'))
    assert.ok(!md.includes('## Warnings'))
    assert.ok(!md.includes('- Source:'))
  })

  it('keeps only the last lines of a long log', () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const md = reportMarkdown(data({ log }), '')
    assert.match(md, /Last 40 lines — the last 100 are in logs\.txt\./)
    assert.ok(md.includes('line 99') && md.includes('line 60') && !md.includes('line 59\n'))
  })
})

describe('fence', () => {
  it('cannot be closed by the text it holds', () => {
    assert.equal(fence('a ``` b'), '````text\na ``` b\n````')
    assert.equal(fence('plain'), '```text\nplain\n```')
  })
})

describe('reportArchive', () => {
  const names = (archive: Buffer): string[] => {
    const found: string[] = []
    for (let at = archive.indexOf('PK\x01\x02'); at >= 0; at = archive.indexOf('PK\x01\x02', at + 4)) {
      found.push(archive.subarray(at + 46, at + 46 + archive.readUInt16LE(at + 28)).toString())
    }
    return found
  }

  it('holds the report, the screenshot when kept, and the log', () => {
    assert.deepEqual(names(reportArchive(data(), 'x', Buffer.from('png'))), ['report.md', 'screenshot.png', 'logs.txt'])
    assert.deepEqual(names(reportArchive(data({ log: [] }), 'x')), ['report.md'])
  })

  it('writes the description into report.md', () => {
    const archive = reportArchive(data(), 'The viewer stayed empty')
    const size = archive.readUInt32LE(18)
    const nameLength = archive.readUInt16LE(26)
    const body = archive.subarray(30 + nameLength, 30 + nameLength + size)
    const text = (archive.readUInt16LE(8) === 8 ? inflateRawSync(body) : body).toString('utf-8')
    assert.match(text, /The viewer stayed empty/)
  })
})

describe('reportFileName', () => {
  it('names the application and the moment, and nothing a file system refuses', () => {
    assert.equal(reportFileName('Modly · feat/new: thing', at), 'bug-report-modly-feat-new-thing-20260911-104213.zip')
    assert.equal(reportFileName('···', at), 'bug-report-app-20260911-104213.zip')
  })
})

describe('clock', () => {
  it('reads hours, minutes and seconds', () => {
    assert.equal(clock(at), '10:42:13')
  })
})

describe('readLogTail', () => {
  it('reads the end of a log without colours, masked as a whole', async () => {
    const path = join(dir, 'branch.log')
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
    writeFileSync(path, `first\n\x1b[32mINFO\x1b[0m ready token=abc\n${key}\n\nlast\n`)
    assert.deepEqual(await readLogTail(path, {}), ['first', 'INFO ready token=[redacted]', '[redacted]', 'last'])
  })

  it('drops the partial first line of a large log, and keeps the last lines', async () => {
    const path = join(dir, 'large.log')
    writeFileSync(path, Array.from({ length: 1000 }, (_, i) => `line number ${i}`).join('\n'))
    const lines = await readLogTail(path, {}, 50, 2000)
    assert.equal(lines.length, 50)
    assert.equal(lines.at(-1), 'line number 999')
    const partial = await readLogTail(path, {}, 1000, 100)
    assert.ok(partial.every((line) => /^line number \d+$/.test(line)))
  })

  it('reads nothing from a log that does not exist', async () => {
    assert.deepEqual(await readLogTail(join(dir, 'missing.log'), {}), [])
  })
})

describe('environment', () => {
  it('describes the machine without naming anyone', async () => {
    const window = new BrowserWindow({ width: 1280, height: 860 })
    const lines = await environment(window)
    assert.match(lines[0], /^System: /)
    assert.ok(lines.includes('Language: en-US'))
    assert.ok(lines.includes('GPU: NVIDIA GeForce RTX 5070 (driver 32.0.15.9186)'))
    assert.ok(lines.includes('Window: 1280×860 at 150%'))
    assert.ok(lines.some((line) => /^Memory: \d+ GB$/.test(line)))
  })
})
