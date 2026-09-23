import assert from 'node:assert/strict'
import { BrowserWindow, type WebContents } from 'electron'
import { describe, it } from 'node:test'
import { Journal, TIMELINE_MS, watchContents } from './journal'
import { RECORDER_WORLD } from './recorder'

interface StubContents {
  loading: boolean
  scripts: { world: number; code: string }[]
  isolated: (code: string) => unknown
  emit(event: string, ...args: unknown[]): void
}

function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let now = start
  return { now: () => now, advance: (ms) => void (now += ms) }
}

const contentsOf = (): { contents: WebContents; stub: StubContents } => {
  const window = new BrowserWindow({})
  return { contents: window.webContents, stub: window.webContents as unknown as StubContents }
}

describe('Journal', () => {
  it('masks what it records', () => {
    const journal = new Journal({ home: process.platform === 'win32' ? 'C:\\Users\\Ann' : '/home/ann' })
    const path = process.platform === 'win32' ? 'C:\\Users\\Ann\\app.js' : '/home/ann/app.js'
    journal.add('error', 'Console error: token=abc123', `at ${path}:3`)
    const [entry] = journal.snapshot().errors
    assert.equal(entry.text, 'Console error: token=[redacted]')
    assert.match(entry.detail ?? '', /^at ~[\\/]app\.js:3$/)
  })

  it('counts an entry repeated in a row instead of keeping every copy', () => {
    const journal = new Journal({})
    for (let i = 0; i < 5; i++) journal.add('error', 'Console error: boom')
    journal.add('action', 'Clicked button "Run"')
    journal.add('action', 'Clicked button "Run"')
    const { errors, timeline } = journal.snapshot()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].count, 5)
    assert.equal(timeline.filter((e) => e.kind === 'action')[0].count, 2)
  })

  it('keeps the last minutes in the timeline, and errors however old', () => {
    const clock = clockAt(1_000_000)
    const journal = new Journal({}, clock.now)
    journal.add('error', 'Old error')
    journal.add('action', 'Old click')
    clock.advance(TIMELINE_MS + 1)
    journal.add('warning', 'A warning')
    journal.add('action', 'New click')
    journal.navigation('http://127.0.0.1:8188/?token=1#/graph')
    journal.add('crash', 'Page gone')

    const { timeline, errors, warnings } = journal.snapshot()
    assert.deepEqual(
      timeline.map((e) => e.text),
      ['New click', 'Went to http://127.0.0.1:8188/?…#/graph', 'Page gone']
    )
    assert.deepEqual(errors.map((e) => e.text), ['Page gone', 'Old error'])
    assert.deepEqual(warnings.map((e) => e.text), ['A warning'])
  })

  it('orders the timeline by time, whatever order entries arrived in', () => {
    const journal = new Journal({}, () => 5000)
    journal.add('navigation', 'Went to b', undefined, 3000)
    journal.add('action', 'Clicked a', undefined, 2000)
    assert.deepEqual(journal.snapshot().timeline.map((e) => e.text), ['Clicked a', 'Went to b'])
  })

  it('keeps entries short, whatever a page calls its elements', () => {
    const journal = new Journal({})
    journal.add('action', `Clicked button#${'x'.repeat(100_000)}`)
    assert.equal(journal.snapshot().timeline[0].text.length, 500)
    // A token across the cut is masked whole, not left half recognisable.
    journal.add('error', `${'x '.repeat(247)}${'ghp'}_abcdefghijklmnopqrstuvwxyz0123456789`)
    const cut = journal.snapshot().errors[0].text
    assert.equal(cut.length, 500)
    assert.ok(cut.endsWith(' [redac') && !cut.includes('ghp_'), cut.slice(-20))
  })

  it('keeps a bounded number of entries', () => {
    const journal = new Journal({})
    for (let i = 0; i < 250; i++) journal.add('action', `Clicked ${i}`)
    for (let i = 0; i < 150; i++) journal.add('error', `Error ${i}`)
    const { timeline, errors } = journal.snapshot()
    assert.equal(timeline.filter((e) => e.kind === 'action').length, 200)
    assert.equal(errors.length, 100)
    assert.equal(errors[0].text, 'Error 149')
  })

  it('gives copies: a snapshot does not change afterwards', () => {
    const journal = new Journal({})
    journal.add('error', 'boom')
    const snapshot = journal.snapshot()
    journal.add('error', 'boom')
    assert.equal(snapshot.errors[0].count, undefined)
  })
})

describe('watchContents', () => {
  it('records console errors and warnings, in the arguments of old and new Electron', () => {
    const { contents, stub } = contentsOf()
    const journal = new Journal({})
    watchContents(contents, journal)
    // Electron 35 and later: one event object.
    stub.emit('console-message', { level: 'error', message: 'Uncaught TypeError: x is undefined\n    at run (app.js:3)', lineNumber: 3, sourceId: 'app.js' })
    // Before: positional arguments, numeric levels.
    stub.emit('console-message', {}, 2, '%cDeprecated API', 10, 'lib.js')
    stub.emit('console-message', { level: 'info', message: 'hello' })
    const { errors, warnings } = journal.snapshot()
    assert.equal(errors[0].text, 'Console error: Uncaught TypeError: x is undefined')
    assert.match(errors[0].detail ?? '', /at run \(app\.js:3\)\n {4}at app\.js:3$/)
    assert.equal(warnings[0].text, 'Console warning: Deprecated API')
    assert.equal(errors.length + warnings.length, 2)
  })

  it('records navigation, failed loads, crashes and hangs', () => {
    const { contents, stub } = contentsOf()
    const journal = new Journal({})
    watchContents(contents, journal)
    stub.emit('did-navigate', {}, 'http://127.0.0.1:3000/login?next=/admin')
    stub.emit('did-navigate-in-page', {}, 'http://127.0.0.1:3000/#/settings', true)
    stub.emit('did-navigate-in-page', {}, 'http://ads.example.com/frame', false)
    stub.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:3000/x', true)
    stub.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:3000/api?key=1', true)
    stub.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    stub.emit('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 })
    stub.emit('unresponsive')
    stub.emit('preload-error', {}, 'preload.js', new Error('Cannot find module'))

    const { timeline } = journal.snapshot()
    assert.deepEqual(
      timeline.map((e) => `${e.kind}: ${e.text}`),
      [
        'navigation: Went to http://127.0.0.1:3000/login?…',
        'navigation: Went to http://127.0.0.1:3000/#/settings',
        'error: The page failed to load http://127.0.0.1:3000/api?…: ERR_CONNECTION_REFUSED (-102)',
        "crash: The page's process is gone: oom (exit code -536870904)",
        'error: The page stopped responding',
        'error: Preload script failed: preload.js: Cannot find module'
      ]
    )
  })

  it('injects the recorder into every document and takes its actions', async () => {
    const { contents, stub } = contentsOf()
    const journal = new Journal({})
    stub.isolated = (code) => (code.includes('__tmdTake()') ? [{ t: Date.now(), kind: 'click', target: 'button "Run"' }, { bogus: true }] : undefined)
    const recording = watchContents(contents, journal)
    // Already loaded when watched: injected at once.
    assert.equal(stub.scripts.length, 1)
    assert.equal(stub.scripts[0].world, RECORDER_WORLD)
    assert.match(stub.scripts[0].code, /__tmdTake/)

    stub.emit('dom-ready')
    assert.equal(stub.scripts.length, 2)

    await recording.take()
    assert.deepEqual(journal.snapshot().timeline.map((e) => e.text), ['Clicked button "Run"'])
  })

  it('takes the actions of a document about to be replaced', async () => {
    const { contents, stub } = contentsOf()
    const journal = new Journal({})
    let takes = 0
    stub.isolated = (code) => {
      if (code.includes('__tmdTake()')) takes++
      return []
    }
    watchContents(contents, journal)
    stub.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    stub.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    stub.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    // Before Electron 25: positional arguments.
    stub.emit('did-start-navigation', {}, 'http://x/', false, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(takes, 2)
  })

  it('gives the recorder to a document that missed it', async () => {
    const { contents, stub } = contentsOf()
    // Shown while still loading, after dom-ready: the page has no recorder yet.
    stub.loading = true
    stub.isolated = (code) => (code.includes('__tmdTake()') ? null : undefined)
    const recording = watchContents(contents, new Journal({}))
    assert.equal(stub.scripts.length, 1, 'injected at once, loading or not')
    await recording.take()
    assert.equal(stub.scripts.length, 3)
    assert.match(stub.scripts[2].code, /^\(function recorder/)
  })

  it('survives a page between two documents', async () => {
    const { contents, stub } = contentsOf()
    stub.isolated = () => {
      throw new Error('Script failed to execute')
    }
    const recording = watchContents(contents, new Journal({}))
    await recording.take()
  })
})
