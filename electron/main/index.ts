import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { syncAgent } from './agent'
import { appLog, errorText } from './applog'
import { resolveSource } from './github'
import { registerIpc } from './ipc'
import { reattach, refresh, startBranch } from './jobs'
import * as registry from './registry'
import { confine, restrictPermissions } from './security'
import { parseInput } from './source-url'
import {
  appIcon,
  appLogPath,
  appsDir,
  chooseUserData,
  registryBackupPath,
  registryPath,
  rootDir,
  storeDir
} from './paths'
import { preferences } from './settings'
import { prune, setIdleCachesAside } from './storage'
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

/**
 * Everything reads the registry: unreadable, TryMyDev would start with no window at all. It
 * offers the previous version instead, keeping the unreadable file beside it.
 */
async function registryUsable(): Promise<boolean> {
  const problem = registry.problem()
  if (!problem) return true
  appLog(`[registry] ${problem.message}`)
  const canRestore = registry.backupReadable()
  const saved = canRestore ? statSync(registryBackupPath()).mtime.toLocaleString() : ''
  const buttons = canRestore ? ['Restore the previous version', 'Show the file', 'Quit'] : ['Show the file', 'Quit']
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: PRODUCT.name,
    message: 'The list of applications cannot be read',
    detail: canRestore
      ? `${problem.message}\n\nIts previous version, saved ${saved}, can take its place. The unreadable file is kept beside it.`
      : problem.message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  })
  if (canRestore && response === 0) {
    try {
      const broken = registry.restoreBackup()
      appLog(`[registry] restored its previous version; the unreadable one is ${broken}`)
      return true
    } catch (err) {
      dialog.showErrorBox(`${PRODUCT.name} — restore failed`, errorText(err))
    }
  } else if (buttons[response] === 'Show the file') {
    shell.showItemInFolder(registryPath())
  }
  app.quit()
  return false
}

/**
 * Unused environments, leftovers of removed branches, and download caches idle for two weeks.
 * The caches are set aside before anything can install; the deleting goes on in the
 * background, under the same locks as installs.
 */
async function cleanUpAtStart(): Promise<void> {
  const setAside = await setIdleCachesAside()
  if (setAside.length > 0) appLog(`[storage] idle download caches set aside: ${setAside.join(', ')}`)
  void prune()
    .then((bytes) => {
      if (bytes > 0) appLog(`[storage] cleaned up at start: ${(bytes / 1024 ** 3).toFixed(2)} GB freed`)
    })
    .catch((err) => appLog(`[storage] cleanup at start failed: ${errorText(err)}`))
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

    if (!(await registryUsable())) return

    const moved = await registry.migrateKeys((folder, err) =>
      appLog(`[app] ${folder} keeps its old key for now: ${err.code} — a file inside is open elsewhere`)
    )
    if (moved > 0) appLog(`[app] ${moved} branch folder(s) moved to short keys`)
    await reattach(() => mainWindow)
    if (preferences().autoCleanup) await cleanUpAtStart()

    registerIpc(() => mainWindow, home)
    createWindow()
    if (preferences().agent) void syncAgent(true, () => mainWindow)

    setInterval(() => {
      if (mainWindow) void refresh(mainWindow, registry.branches())
    }, UPDATE_CHECK_MS).unref()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err) => {
    // A start that fails before the window exists would leave TryMyDev running unseen.
    appLog(`[app] start failed: ${errorText(err)}`)
    dialog.showErrorBox(`${PRODUCT.name} could not start`, `${errorText(err)}\n\nDetails are in ${appLogPath()}.`)
    app.quit()
  })

  // Applications we started are detached on purpose: closing TryMyDev leaves
  // them running.
  app.on('window-all-closed', () => app.quit())
}
