import { app, BrowserWindow, dialog, session } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { appLog, errorText } from './applog'
import { resolveSource } from './github'
import { registerIpc } from './ipc'
import { reattach, refresh, startBranch } from './jobs'
import * as registry from './registry'
import { confine, restrictPermissions } from './security'
import { parseInput } from './source-url'
import { appIcon, appsDir, chooseUserData, rootDir, storeDir } from './paths'
import { PRODUCT } from './types'

let mainWindow: BrowserWindow | null = null

/** Branches are checked again this often; one that has not moved costs no request. */
const UPDATE_CHECK_MS = 15 * 60_000

app.setName(PRODUCT.name)
chooseUserData()

/** The page of the TryMyDev window: the dev server's while developing. */
const devServer = process.env['ELECTRON_RENDERER_URL']
const page = join(__dirname, '../renderer/index.html')
const home = devServer ?? pathToFileURL(page).href

process.on('uncaughtException', (err) => {
  appLog(`[uncaught] ${errorText(err)}`)
  if (app.isReady()) dialog.showErrorBox(`${PRODUCT.name} — unexpected error`, errorText(err))
})
process.on('unhandledRejection', (reason) => appLog(`[unhandled] ${errorText(reason)}`))

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12131a',
    icon: appIcon(),
    // The page draws the title bar (.titlebar), 40 px high; the system keeps its own buttons.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#14151d', symbolColor: '#e7e9f0', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    void autoStart()
  })
  // A web application's window may keep TryMyDev alive after this one is gone.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  confine(mainWindow.webContents, home)
  if (devServer) void mainWindow.loadURL(devServer)
  else void mainWindow.loadFile(page)
}

/**
 * `trymydev --start=owner/repo@branch` adds the branch if needed and runs it,
 * so a tester can keep a desktop shortcut for the one branch they follow.
 * An unapproved manifest still stops for review.
 */
async function autoStart(argv: string[] = process.argv): Promise<void> {
  const arg = argv.find((a) => a.startsWith('--start='))?.slice('--start='.length)
  if (!arg || !mainWindow) return
  try {
    const { source, upstream } = await resolveSource(parseInput(arg))
    const entry = registry.addApp(upstream)
    const branch = registry.addBranch(entry.id, source)
    await startBranch(mainWindow, branch.key)
  } catch (err) {
    mainWindow.webContents.send('job:error', {
      key: arg,
      step: 'resolve',
      message: err instanceof Error ? err.message : String(err),
      logTail: '',
      logPath: ''
    })
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    void autoStart(argv)
  })

  app.whenReady().then(async () => {
    for (const dir of [rootDir(), storeDir(), appsDir()]) mkdirSync(dir, { recursive: true })
    appLog(`[app] ${PRODUCT.name} ${app.getVersion()} started`)
    // Packaged, the bundle's .icns is the Dock icon; unpackaged, it would be Electron's.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon())
    // Electron grants every permission a page asks for; the TryMyDev window needs none.
    restrictPermissions(session.defaultSession)

    const moved = await registry.migrateKeys((folder, err) =>
      appLog(`[app] ${folder} keeps its old key for now: ${err.code} — a file inside is open elsewhere`)
    )
    if (moved > 0) appLog(`[app] ${moved} branch folder(s) moved to short keys`)
    await reattach(() => mainWindow)

    registerIpc(() => mainWindow, home)
    createWindow()

    setInterval(() => {
      if (mainWindow) void refresh(mainWindow, registry.branches())
    }, UPDATE_CHECK_MS).unref()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Applications we started are detached on purpose: closing TryMyDev leaves
  // them running.
  app.on('window-all-closed', () => app.quit())
}
