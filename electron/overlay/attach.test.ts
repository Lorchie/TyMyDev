import assert from 'node:assert/strict'
import { BrowserWindow, dialog, session, shell } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { attachOverlay, COLLAPSED, DEFAULT_ANCHOR, placement, snap, type OverlayOptions } from './attach'
import { Journal } from './journal'
import { until } from '../main/testing'

interface StubContents {
  id: number
  url?: string
  file?: string
  focused: number
  closed: boolean
  isolated: (code: string) => unknown
  openHandler?: () => { action: string }
  ipc: {
    handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown>
    listeners: Record<string, (event: unknown, ...args: unknown[]) => void>
  }
  emit(event: string, ...args: unknown[]): void
}
interface StubView {
  options: { webPreferences: Record<string, unknown> }
  webContents: StubContents
  bounds?: { x: number; y: number; width: number; height: number }
  background?: string
}
interface StubWindow {
  webContents: StubContents
  contentSize: [number, number]
  contentView: { children: StubView[] }
  emit(event: string): void
  destroy(): void
}
interface StubSession {
  requestHandler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
  checkHandler: (contents: unknown, permission: string) => boolean
}
const stubDialog = dialog as unknown as { savePath?: string; asked: { defaultPath: string }[] }
const stubShell = shell as unknown as { shown: string[] }

const dir = mkdtempSync(join(tmpdir(), 'tmd-overlay-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const options: OverlayOptions = { page: '/built/renderer/overlay.html', preload: '/built/preload/overlay.js', label: 'App · main' }
const content = { width: 1280, height: 860 }

function attached(extra: Partial<OverlayOptions> = {}, journal?: Journal): { window: StubWindow; view: StubView } {
  const window = new BrowserWindow({ width: content.width, height: content.height })
  const view = attachOverlay(window, { ...options, ...extra }, journal)
  return { window: window as unknown as StubWindow, view: view as unknown as StubView }
}

const invoke = (view: StubView, channel: string, ...args: unknown[]): unknown => view.webContents.ipc.handlers[channel]({}, ...args)
const send = (view: StubView, channel: string, ...args: unknown[]): void => view.webContents.ipc.listeners[channel]({}, ...args)

describe('placement', () => {
  it('sits in the bottom-right corner by default', () => {
    assert.deepEqual(placement(content, COLLAPSED), { x: 1216, y: 796, width: 52, height: 52 })
  })

  it('never grows past a small window', () => {
    assert.deepEqual(placement({ width: 60, height: 40 }, { width: 260, height: 200 }), { x: 12, y: 12, width: 36, height: 16 })
  })

  it('keeps the button where it was anchored, and opens the panel away from the nearer edge', () => {
    const left = { side: 'left', y: 0.25 } as const
    assert.deepEqual(placement(content, COLLAPSED, left), { x: 12, y: 189, width: 52, height: 52 })
    // Upper half: the panel grows down from the button's top.
    assert.deepEqual(placement(content, { width: 300, height: 400 }, left), { x: 12, y: 189, width: 300, height: 400 })
    // Lower half: it grows up from the button's bottom, and stays inside the window.
    const low = { side: 'right', y: 0.6 } as const
    assert.deepEqual(placement(content, COLLAPSED, low), { x: 1216, y: 490, width: 52, height: 52 })
    assert.deepEqual(placement(content, { width: 300, height: 400 }, low), { x: 968, y: 142, width: 300, height: 400 })
    assert.equal(placement(content, { width: 300, height: 700 }, low).y, 12)
  })
})

describe('snap', () => {
  it('goes to the nearer side, at the height it was dropped', () => {
    assert.deepEqual(snap({ x: 100, y: 215 }, content), { side: 'left', y: 0.25 })
    assert.deepEqual(snap({ x: 900, y: 2000 }, content), { side: 'right', y: 1 })
    assert.deepEqual(snap({ x: 'a', y: 1 }, content), DEFAULT_ANCHOR)
    assert.deepEqual(snap(null, content), DEFAULT_ANCHOR)
  })
})

describe('attachOverlay', () => {
  it('puts a transparent, sandboxed view on the window, in a session that grants nothing', () => {
    const { window, view } = attached()
    assert.equal(window.contentView.children.at(-1), view)
    assert.equal(view.background, '#00000000')
    assert.deepEqual(view.options.webPreferences, {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'trymydev-overlay'
    })
    assert.equal(view.webContents.file, options.page)
    assert.deepEqual(view.bounds, placement(content, COLLAPSED))

    const overlaySession = session.fromPartition('trymydev-overlay') as unknown as StubSession
    let granted: boolean | undefined
    overlaySession.requestHandler({}, 'media', (g) => (granted = g))
    assert.equal(granted, false)
    assert.equal(overlaySession.checkHandler({}, 'clipboard-read'), false)
  })

  it('loads the dev server page as a URL', () => {
    const { view } = attached({ page: 'http://localhost:5173/overlay.html' })
    assert.equal(view.webContents.url, 'http://localhost:5173/overlay.html')
  })

  it('tells its page what it is attached to and where the button sits', async () => {
    const { view } = attached()
    assert.deepEqual(await invoke(view, 'overlay:info'), { label: options.label, anchor: DEFAULT_ANCHOR })
  })

  it('grows into the panel, then gives the keyboard back to the application', () => {
    const { window, view } = attached()
    send(view, 'overlay:resize', { width: 272, height: 150 }, true)
    assert.deepEqual(view.bounds, { x: 996, y: 698, width: 272, height: 150 })
    assert.equal(window.webContents.focused, 0)

    send(view, 'overlay:resize', COLLAPSED, false)
    assert.deepEqual(view.bounds, placement(content, COLLAPSED))
    assert.equal(window.webContents.focused, 1)
  })

  it('bounds whatever size its page asks for', () => {
    const { view } = attached()
    send(view, 'overlay:resize', { width: 5000, height: -3 }, true)
    assert.equal(view.bounds?.width, 560)
    assert.equal(view.bounds?.height, 52)
    send(view, 'overlay:resize', 'nonsense', true)
    assert.equal(view.bounds?.width, COLLAPSED.width)
  })

  it('follows its place when the window is resized', () => {
    const { window, view } = attached()
    window.contentSize = [800, 600]
    window.emit('resize')
    assert.deepEqual(view.bounds, placement({ width: 800, height: 600 }, COLLAPSED))
  })

  it('covers the window while the button is dragged, then settles and remembers where', async () => {
    const settings = join(dir, 'app', 'overlay.json')
    const { window, view } = attached({ settings })
    assert.deepEqual(await invoke(view, 'overlay:drag'), { x: 1216, y: 796 })
    assert.deepEqual(view.bounds, { x: 0, y: 0, ...content })
    window.contentSize = [1000, 700]
    window.emit('resize')
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 700 })

    const anchor = await invoke(view, 'overlay:drop', { x: 30, y: 175 })
    assert.deepEqual(anchor, { side: 'left', y: 0.25 })
    assert.deepEqual(view.bounds, placement({ width: 1000, height: 700 }, COLLAPSED, { side: 'left', y: 0.25 }))
    assert.equal(window.webContents.focused, 1)

    await until(() => existsSync(settings))
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf-8')), { anchor: { side: 'left', y: 0.25 } })
    // Another window of the application finds the button there.
    const next = attached({ settings }).view
    assert.deepEqual(next.bounds, placement(content, COLLAPSED, { side: 'left', y: 0.25 }))
  })

  it('ignores settings it cannot read or trust', () => {
    const settings = join(dir, 'broken.json')
    writeFileSync(settings, '{ "anchor": { "side": "top", "y": 3 } }')
    assert.deepEqual(attached({ settings }).view.bounds, placement(content, COLLAPSED))
    writeFileSync(settings, 'not json')
    assert.deepEqual(attached({ settings }).view.bounds, placement(content, COLLAPSED))
  })

  it('stays on its page', () => {
    const { view } = attached()
    assert.deepEqual(view.webContents.openHandler?.(), { action: 'deny' })
    let prevented = false
    view.webContents.emit('will-navigate', { url: 'https://example.com', preventDefault: () => (prevented = true) })
    assert.equal(prevented, true)
  })

  it('closes its page with the window, and ignores a late resize', () => {
    const { window, view } = attached()
    window.destroy()
    assert.equal(view.webContents.closed, true)
    const before = view.bounds
    send(view, 'overlay:resize', { width: 272, height: 150 }, false)
    assert.equal(view.bounds, before)
  })
})

describe('bug report', () => {
  it('records the application window from the start', () => {
    const journal = new Journal({})
    const { window } = attached({}, journal)
    window.webContents.emit('console-message', { level: 'error', message: 'boom' })
    assert.equal(journal.snapshot().errors[0].text, 'Console error: boom')
  })

  it('prepares a report with the last actions, previews it, and saves the chosen parts', async () => {
    const log = join(dir, 'branch.log')
    writeFileSync(log, 'server started\nERROR token=abc123\n')
    const journal = new Journal({})
    const { window, view } = attached({ report: { source: 'owner/app · main', commit: 'abcdef1234567', log } }, journal)
    window.webContents.isolated = (code) =>
      code.includes('__tmdTake()') ? [{ t: Date.now(), kind: 'click', target: 'button "Export"' }] : undefined
    window.webContents.emit('console-message', { level: 'error', message: 'Export failed' })

    const prepared = (await invoke(view, 'overlay:report:start')) as { markdown: string; logs: string; screenshot?: string }
    assert.match(prepared.markdown, /Clicked button "Export"/)
    assert.match(prepared.markdown, /\*\*\d\d:\d\d:\d\d\*\* Console error: Export failed/)
    assert.match(prepared.markdown, /- Source: owner\/app · main · commit abcdef123456/)
    assert.equal(prepared.logs, 'server started\nERROR token=[redacted]')
    assert.equal(prepared.screenshot, 'data:image/png;base64,ZmFrZS1wbmc=')

    // Actions after the report was asked for are not in it.
    journal.add('action', 'Clicked later')
    const preview = (await invoke(view, 'overlay:report:preview', 'It froze with token=abc123')) as string
    assert.match(preview, /## What happened\n\nIt froze with token=\[redacted\]\n/)
    assert.ok(!preview.includes('Clicked later'))

    stubDialog.savePath = undefined
    assert.equal(await invoke(view, 'overlay:report:save', { description: 'It froze', screenshot: true }), null)
    assert.match(stubDialog.asked.at(-1)!.defaultPath, /bug-report-app-main-\d{8}-\d{6}\.zip$/)

    const path = join(dir, 'report.zip')
    stubDialog.savePath = path
    assert.equal(await invoke(view, 'overlay:report:save', { description: 'It froze', screenshot: false }), 'report.zip')
    const archive = readFileSync(path)
    assert.ok(archive.includes('report.md') && archive.includes('logs.txt'))
    assert.ok(!archive.includes('screenshot.png'), 'the tester left the screenshot out')

    await invoke(view, 'overlay:report:show')
    assert.equal(stubShell.shown.at(-1), path)
  })

  it('saves nothing before a report was prepared, or after it was closed', async () => {
    const { view } = attached()
    stubDialog.savePath = join(dir, 'never.zip')
    assert.equal(await invoke(view, 'overlay:report:save', { description: 'x' }), null)
    await invoke(view, 'overlay:report:start')
    send(view, 'overlay:report:close')
    assert.equal(await invoke(view, 'overlay:report:save', { description: 'x' }), null)
    assert.equal(await invoke(view, 'overlay:report:preview', 'x'), '')
    assert.ok(!existsSync(join(dir, 'never.zip')))
  })
})
