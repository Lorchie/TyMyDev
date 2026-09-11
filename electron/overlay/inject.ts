import { app, WebContentsView, type BrowserWindow } from 'electron'
import { attachOverlay, type OverlayOptions } from './attach'
import { Journal } from './journal'

/**
 * Preloaded into a tested Electron application — `electron -r inject.js <checkout>`, which
 * Electron's default app runs before the application's own code — so every window it opens
 * gets the overlay. Nothing here may break the application: a failure is only logged, and
 * nothing changes how it handles its own errors.
 */

/** Dialogs and splash screens are left alone. */
const SMALLEST = { width: 400, height: 300 }

const log = (message: string): void => console.error(`[trymydev] ${message}`)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function install(options: OverlayOptions): void {
  if (typeof WebContentsView !== 'function') {
    log(`no overlay: Electron ${process.versions.electron} predates WebContentsView (30)`)
    return
  }
  // One journal for the application: its main process fails for every window at once.
  const journal = new Journal()
  // A monitor, unlike an `uncaughtException` listener, leaves the application's own handling as it was.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    const what = origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception'
    journal.add('crash', `Main process: ${what}: ${messageOf(err).split('\n')[0]}`, err instanceof Error ? err.stack : undefined)
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      journal.add('crash', `The ${details.type} process is gone: ${details.reason} (exit code ${details.exitCode})`)
    }
  })

  const attached = new WeakSet<BrowserWindow>()
  const attach = (window: BrowserWindow): void => {
    if (attached.has(window) || window.isDestroyed() || window.getParentWindow()) return
    const [width, height] = window.getContentSize()
    if (width < SMALLEST.width || height < SMALLEST.height) return
    attached.add(window)
    try {
      attachOverlay(window, options, journal)
    } catch (err) {
      log(`no overlay on a window: ${messageOf(err)}`)
    }
  }
  app.on('browser-window-created', (_event, window) => {
    if (window.isVisible()) attach(window)
    else window.once('show', () => attach(window))
  })
}

const raw = process.env.TRYMYDEV_OVERLAY
// The application's own child processes have no use for it.
delete process.env.TRYMYDEV_OVERLAY
try {
  if (raw) install(JSON.parse(raw) as OverlayOptions)
} catch (err) {
  log(`no overlay: ${messageOf(err)}`)
}
