import { app, dialog, session, shell, WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { Journal, watchContents } from './journal'
import { redactText } from './redact'
import { environment, readLogTail, reportArchive, reportFileName, reportMarkdown, type ReportData, type ReportSource } from './report'

/**
 * The TryMyDev overlay: a small transparent view on top of a tested application's window,
 * home of the tester's tools. It runs in TryMyDev for web applications, and inside the
 * tested application itself for Electron ones (see inject.ts) — so this module and the
 * ones it imports use nothing but Electron and Node.
 */

export interface OverlayOptions {
  /** A URL while developing, a file once built. */
  page: string
  preload: string
  /** Application and branch, as the tester knows them. */
  label: string
  /** Where the button's place is remembered, one file per application. */
  settings?: string
  report?: ReportSource
}

export interface OverlaySize {
  width: number
  height: number
}

/** The edge the button sits on, and the height of its centre as a share of the window's. */
export interface Anchor {
  side: 'left' | 'right'
  y: number
}

const MARGIN = 12
export const COLLAPSED: OverlaySize = { width: 52, height: 52 }
const LARGEST: OverlaySize = { width: 560, height: 820 }
export const DEFAULT_ANCHOR: Anchor = { side: 'right', y: 1 }
/** In memory, and apart from the application's own sessions and their handlers. */
const PARTITION = 'trymydev-overlay'
const DESCRIPTION_CHARS = 10_000

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

/**
 * The view on its edge, never larger than the window. The open panel keeps the button's
 * corner: it grows up from a button in the lower half, down from one in the upper half.
 */
export function placement(content: OverlaySize, size: OverlaySize, anchor: Anchor = DEFAULT_ANCHOR): Rectangle {
  const width = Math.max(Math.min(size.width, content.width - 2 * MARGIN), 0)
  const height = Math.max(Math.min(size.height, content.height - 2 * MARGIN), 0)
  const x = anchor.side === 'right' ? content.width - width - MARGIN : MARGIN
  const buttonTop = clamp(anchor.y * content.height - COLLAPSED.height / 2, MARGIN, content.height - COLLAPSED.height - MARGIN)
  const top = anchor.y >= 0.5 ? buttonTop + COLLAPSED.height - height : buttonTop
  return { x: Math.max(x, 0), y: Math.max(clamp(top, MARGIN, content.height - height - MARGIN), 0), width, height }
}

/** Where a dropped button settles: the nearer side, at the height it was let go. */
export function snap(point: unknown, content: OverlaySize): Anchor {
  const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return DEFAULT_ANCHOR
  return { side: x < content.width / 2 ? 'left' : 'right', y: clamp(y / Math.max(content.height, 1), 0, 1) }
}

function validAnchor(value: unknown): Anchor | undefined {
  const anchor = value as Anchor | undefined
  if (!anchor || (anchor.side !== 'left' && anchor.side !== 'right') || !Number.isFinite(anchor.y)) return undefined
  return { side: anchor.side, y: clamp(anchor.y, 0, 1) }
}

function readAnchor(settings?: string): Anchor {
  if (!settings) return DEFAULT_ANCHOR
  try {
    return validAnchor((JSON.parse(readFileSync(settings, 'utf-8')) as { anchor?: unknown }).anchor) ?? DEFAULT_ANCHOR
  } catch {
    return DEFAULT_ANCHOR
  }
}

/** The page asks for its size; anything else than a sensible one gets the collapsed button. */
function bounded(requested: unknown): OverlaySize {
  const { width, height } = (requested ?? {}) as Partial<OverlaySize>
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    return COLLAPSED
  }
  return {
    width: Math.round(clamp(width, COLLAPSED.width, LARGEST.width)),
    height: Math.round(clamp(height, COLLAPSED.height, LARGEST.height))
  }
}

/**
 * The view only covers what it shows — the button, or the open panel — since everything
 * under it stops receiving the application's clicks. While the button is dragged it covers
 * the whole window, so the pointer never leaves it.
 */
export function attachOverlay(window: BrowserWindow, options: OverlayOptions, journal = new Journal()): WebContentsView {
  const overlaySession = session.fromPartition(PARTITION)
  overlaySession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  overlaySession.setPermissionCheckHandler(() => false)

  const view = new WebContentsView({
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION
    }
  })
  view.setBackgroundColor('#00000000')
  const contents = view.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())

  const recording = watchContents(window.webContents, journal)

  let size = COLLAPSED
  let anchor = readAnchor(options.settings)
  let dragging = false
  let bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  const contentSize = (): OverlaySize => {
    const [width, height] = window.getContentSize()
    return { width, height }
  }
  const place = (): void => {
    if (window.isDestroyed()) return
    const content = contentSize()
    bounds = dragging ? { x: 0, y: 0, ...content } : placement(content, size, anchor)
    view.setBounds(bounds)
  }

  // Scoped to the overlay's own page: the tested application cannot reach these channels.
  const ipc = contents.ipc
  ipc.handle('overlay:info', () => ({ label: options.label, anchor }))
  ipc.on('overlay:resize', (_event, requested: unknown, open: unknown) => {
    size = bounded(requested)
    place()
    // Keyboard shortcuts go back to the application once the panel closes.
    if (open !== true && !window.isDestroyed()) window.webContents.focus()
  })

  ipc.handle('overlay:drag', () => {
    const from = { x: bounds.x, y: bounds.y }
    dragging = true
    place()
    return from
  })
  ipc.handle('overlay:drop', (_event, point: unknown) => {
    dragging = false
    anchor = snap(point, contentSize())
    size = COLLAPSED
    place()
    const settings = options.settings
    if (settings) {
      void mkdir(dirname(settings), { recursive: true })
        .then(() => writeFile(settings, JSON.stringify({ anchor })))
        .catch(() => undefined)
    }
    if (!window.isDestroyed()) window.webContents.focus()
    return anchor
  })

  // A report is prepared once — screenshot and journal as they were when the tester asked —
  // then previewed as they type their description, and saved where they choose.
  let prepared: { data: ReportData; screenshot?: Buffer } | undefined
  let saved: string | undefined

  ipc.handle('overlay:report:start', async () => {
    await recording.take()
    const image = await window.webContents.capturePage()
    const screenshot = image.isEmpty() ? undefined : image.toPNG()
    const data: ReportData = {
      label: options.label,
      source: options.report,
      at: Date.now(),
      environment: await environment(window),
      journal: journal.snapshot(),
      log: options.report?.log ? await readLogTail(options.report.log, journal.context) : []
    }
    prepared = { data, screenshot }
    saved = undefined
    return {
      markdown: reportMarkdown(data, ''),
      logs: data.log.join('\n'),
      screenshot: screenshot ? image.resize({ width: 400 }).toDataURL() : undefined
    }
  })

  // Masked too: a tester pastes error messages, and what they hold, into their description.
  const describedBy = (description: unknown): string =>
    typeof description === 'string' ? redactText(description.slice(0, DESCRIPTION_CHARS), journal.context) : ''

  ipc.handle('overlay:report:preview', (_event, description: unknown) =>
    prepared ? reportMarkdown(prepared.data, describedBy(description)) : ''
  )

  ipc.handle('overlay:report:save', async (_event, choice: unknown) => {
    if (!prepared || window.isDestroyed()) return null
    const { description, screenshot } = (choice ?? {}) as { description?: unknown; screenshot?: unknown }
    let folder: string
    try {
      folder = app.getPath('desktop')
    } catch {
      folder = homedir()
    }
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save the bug report',
      defaultPath: join(folder, reportFileName(options.label, prepared.data.at)),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return null
    const archive = reportArchive(
      prepared.data,
      describedBy(description),
      screenshot === false ? undefined : prepared.screenshot
    )
    await writeFile(filePath, archive)
    saved = filePath
    return basename(filePath)
  })

  ipc.handle('overlay:report:show', () => {
    if (saved) shell.showItemInFolder(saved)
  })

  ipc.on('overlay:report:close', () => {
    prepared = undefined
  })

  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    window.on(event as 'resize', place)
  }
  window.once('closed', () => {
    if (!contents.isDestroyed()) contents.close()
  })

  window.contentView.addChildView(view)
  place()
  void (/^https?:/.test(options.page) ? contents.loadURL(options.page) : contents.loadFile(options.page))
  return view
}
