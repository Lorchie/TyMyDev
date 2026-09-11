import { app as electronApp, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { createConnection, createServer } from 'net'
import { basename, join } from 'path'
import { attachOverlay, type OverlayOptions } from '../overlay/attach'
import { startFor } from './manifest'
import { writeJson } from './fsx'
import {
  appShared,
  appSharedDir,
  branchDataDir,
  appIcon,
  checkoutDir,
  overlayFiles,
  overlaySettingsPath,
  rootDir,
  shortDir,
  shortOwnerPath
} from './paths'
import { label as sourceLabel } from './registry'
import {
  buildEnv,
  capture,
  isAlive,
  killTree,
  startProcess,
  type RunContext,
  type Toolchain
} from './proc'
import { branchSession, confine } from './security'
import { placeSeeds } from './seed'
import type { BranchLog } from './logger'
import type { App, Branch, BranchState, Manifest } from './types'

interface Running {
  /** Absent for an application taken back after TryMyDev restarted. */
  child?: ChildProcess
  pid: number
  window?: BrowserWindow
  /** Stopped on purpose: a forced kill exits non-zero, and that is no crash. */
  stopped?: boolean
}

const running = new Map<string, Running>()

export function isRunning(key: string): boolean {
  return running.has(key)
}

export function stop(key: string): void {
  const entry = running.get(key)
  if (!entry) return
  entry.stopped = true
  closeWindow(entry.window)
  killTree(entry.child ?? entry.pid)
}

export interface LaunchResult {
  url?: string
  /** How to find a detached application again once TryMyDev has restarted. */
  detached?: BranchState['running']
}

export async function launch(
  app: App,
  branch: Branch,
  manifest: Manifest,
  state: BranchState,
  toolchain: Toolchain,
  log: BranchLog,
  signal: AbortSignal,
  onExit: (code: number | null) => void
): Promise<LaunchResult> {
  const checkout = checkoutDir(app.id, branch.key)
  const data = branchDataDir(app.id, branch.key)
  await mkdir(data, { recursive: true })
  const short = shortDir(app.id)
  // Claimed only by an application that uses it, so Storage knows whose it is.
  if (JSON.stringify(manifest.seed ?? []).includes('{short}') && !existsSync(shortOwnerPath(short))) {
    writeJson(shortOwnerPath(short), { root: rootDir(), appId: app.id })
  }
  await placeSeeds(manifest.seed, {
    checkout,
    data,
    shared: appSharedDir(app.id),
    short,
    documents: electronApp.getPath('documents'),
    venvPython: toolchain.venvPython
  })

  const extraEnv: Record<string, string> = {}
  // A branch must not write into the folder its siblings use; the manifest says
  // which variables point at that folder.
  for (const iso of manifest.isolate ?? []) {
    const dir = join(data, iso.dir)
    await mkdir(dir, { recursive: true })
    extraEnv[iso.env] = dir
  }
  for (const share of manifest.share ?? []) {
    if (share.env) extraEnv[share.env] = appShared(app.id, share.path)
  }

  const ctx: RunContext = { toolchain, cwd: checkout, log, extraEnv }
  const start = startFor(manifest)
  const { page, preload } = overlayFiles()
  const overlay: OverlayOptions = {
    page,
    preload,
    label: `${manifest.name} · ${branch.ref}`,
    settings: overlaySettingsPath(app.id),
    report: { source: sourceLabel(branch), commit: state.builtSha ?? state.sha, log: log.path }
  }

  if (start.mode === 'electron') {
    const bin = state.electronBinary ?? process.execPath
    const child = toLogFile(log, (fd) => launchElectron(bin, checkout, data, overlay, ctx, fd))
    track(branch.key, { child, pid: child.pid ?? 0 }, onExit, log)
    return { detached: identity(child) }
  }

  if (start.mode === 'command') {
    const child = toLogFile(log, (fd) => startProcess(start.run, ctx, fd))
    track(branch.key, { child, pid: child.pid ?? 0 }, onExit, log)
    return { detached: identity(child) }
  }

  // {port} becomes a free port, so two branches run side by side; without it, the
  // manifest's port is simply where the server is expected.
  const templated = start.run.includes('{port}') || (start.url ?? '').includes('{port}')
  const port = templated ? await freePort(start.port) : start.port
  const child = startProcess(substitute(start.run, port), { ...ctx, signal })

  let url: string
  try {
    url = start.url ? substitute(start.url, port) : await waitForUrl(child, port, log)
  } catch (err) {
    killTree(child)
    throw err
  }

  const window = openWindow(url, overlay, branch.key)
  track(branch.key, { child, pid: child.pid ?? 0, window }, onExit, log)
  log.line(`[launch] serving ${url}`)
  return { url }
}

/**
 * Takes back an application still running from before TryMyDev restarted. Its exit
 * code is out of reach, so it is polled until it is gone.
 */
export function adopt(key: string, pid: number, onExit: () => void): void {
  running.set(key, { pid })
  const timer = setInterval(() => {
    if (isAlive(pid)) return
    clearInterval(timer)
    running.delete(key)
    onExit()
  }, 2000)
  timer.unref()
}

function track(
  key: string,
  entry: Running & { child: ChildProcess },
  onExit: (code: number | null) => void,
  log: BranchLog
): void {
  running.set(key, entry)
  entry.child.on('error', (err) => log.line(`[launch] ${err.message}`))
  entry.child.on('close', (code) => {
    running.delete(key)
    closeWindow(entry.window)
    log.line(`[launch] stopped (code ${code})`)
    onExit(entry.stopped ? null : code)
  })
  entry.window?.on('closed', () => {
    if (!running.has(key)) return
    entry.stopped = true
    killTree(entry.child)
  })
}

/** A PID alone could be reused by another program; with its executable and start time it cannot. */
function identity(child: ChildProcess): BranchState['running'] {
  return child.pid === undefined
    ? undefined
    : { pid: child.pid, image: basename(child.spawnfile).toLowerCase(), startedAt: Date.now() }
}

function closeWindow(window?: BrowserWindow): void {
  if (window && !window.isDestroyed()) window.destroy()
}

/**
 * An application that outlives TryMyDev writes straight into the log file: through
 * a pipe, its first line after TryMyDev quits would fail with EPIPE and crash it.
 */
function toLogFile(log: BranchLog, spawnWith: (fd: number) => ChildProcess): ChildProcess {
  const fd = openSync(log.path, 'a')
  try {
    return spawnWith(fd)
  } finally {
    closeSync(fd)
  }
}

// ── Electron applications ─────────────────────────────────────────────────────

/** Electron major the checkout expects, e.g. "42". */
export function expectedElectronMajor(checkout: string): string | undefined {
  const path = join(checkout, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return (pkg.devDependencies?.electron ?? pkg.dependencies?.electron)?.match(/(\d+)/)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Our own binary runs the branch when the major matches — it saves a 150 MB
 * download per branch. Three cases force the branch to bring its own: a different
 * major; a packaged launcher, which has no default app and ignores the folder it is
 * handed; and an AppImage, whose mount disappears when it quits.
 */
export function needsOwnElectron(major: string | undefined): boolean {
  if (electronApp.isPackaged || process.env.APPIMAGE) return true
  return major !== undefined && major !== process.versions.electron.split('.')[0]
}

/** Absolute path of the Electron a checkout brings with it. */
export async function resolveElectronBinary(ctx: RunContext): Promise<string> {
  const out = await capture(`node -p "require('electron')"`, ctx)
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (!line || !existsSync(line)) throw new Error('Electron binary of the branch not found.')
  return line
}

/**
 * Electron's default app preloads `-r` modules before the application's code: the overlay
 * gets into its windows without touching the checkout. Without a build of it, the
 * application still starts — a missing `-r` module would stop it.
 */
function launchElectron(
  bin: string,
  checkout: string,
  data: string,
  overlay: OverlayOptions,
  ctx: RunContext,
  output: number
): ChildProcess {
  const { inject } = overlayFiles()
  const preload = existsSync(inject) ? ['-r', inject] : []
  if (preload.length === 0) ctx.log.line(`[launch] no overlay: ${inject} is missing`)
  const args = [...preload, checkout, `--user-data-dir=${data}`]
  ctx.log.line(`[launch] ${bin} ${args.join(' ')}`)
  // Detached so closing TryMyDev does not take the application down with it.
  return spawn(bin, args, {
    cwd: checkout,
    env: { ...buildEnv(ctx), TRYMYDEV_OVERLAY: JSON.stringify(overlay) },
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: false
  })
}

// ── Servers ───────────────────────────────────────────────────────────────────

function substitute(line: string, port?: number): string {
  return port === undefined ? line : line.replace(/\{port\}/g, String(port))
}

/** A free port per branch, so two branches of the same app can run side by side. */
async function freePort(preferred?: number): Promise<number> {
  const start = preferred ?? 3000
  for (let port = start; port < start + 200; port++) {
    if (await isFree(port)) return port
  }
  throw new Error(`No free port found from ${start}.`)
}

/** Both loopback addresses: a server started by `localhost` often listens on ::1 alone. */
const LOOPBACK = ['127.0.0.1', '::1'] as const

/**
 * Taken when anything answers on it — on Windows, a server listening on every address
 * does not stop another from listening on 127.0.0.1, and would shadow it — or when
 * 127.0.0.1 cannot be listened on. Only loopback is tried: listening on every address
 * would bring up the firewall prompt.
 */
async function isFree(port: number): Promise<boolean> {
  for (const host of LOOPBACK) {
    if (await answers(port, host)) return false
  }
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * A server may take minutes to start on a slow disk, or while an antivirus scans a fresh
 * environment: only one that neither prints nor serves anything for this long is given up.
 */
const SILENCE_MS = 5 * 60_000

/**
 * Frameworks announce their address in their own way, so we watch the output for
 * one — and, when the port is known, we also simply wait for it to answer. The
 * application stopping first, or a cancellation killing it, ends the wait.
 */
async function waitForUrl(child: ChildProcess, port: number | undefined, log: BranchLog): Promise<string> {
  let settled = false
  let silence: NodeJS.Timeout | undefined
  const quiet = new Promise<string>((_resolve, reject) => {
    const arm = (): void => {
      clearTimeout(silence)
      silence = setTimeout(
        () => reject(new Error(`The application printed and served nothing for ${SILENCE_MS / 60_000} minutes.`)),
        SILENCE_MS
      )
    }
    arm()
    child.stdout?.on('data', arm)
    child.stderr?.on('data', arm)
  })
  const fromOutput = new Promise<string>((resolve, reject) => {
    const scan = (chunk: Buffer): void => {
      const match = chunk.toString().match(/https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\])(:\d+)?\S*/)
      // A server listening on every address prints that address; it is reached on loopback.
      if (match) resolve(match[0].replace(/[).,]+$/, '').replace('//0.0.0.0', '//127.0.0.1').replace('//[::]', '//[::1]'))
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.once('close', (code) =>
      reject(new Error(`The application stopped (code ${code}) before serving anything.`))
    )
  })
  const candidates = port === undefined ? [fromOutput, quiet] : [fromOutput, quiet, pollPort(port, () => settled)]

  try {
    const url = await Promise.race(candidates)
    log.line(`[launch] address detected: ${url}`)
    return url
  } finally {
    settled = true
    clearTimeout(silence)
  }
}

async function pollPort(port: number, done: () => boolean): Promise<string> {
  while (!done()) {
    if (await answers(port, '127.0.0.1')) return `http://127.0.0.1:${port}`
    if (await answers(port, '::1')) return `http://[::1]:${port}`
    await new Promise((r) => setTimeout(r, 500))
  }
  return ''
}

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * A tested web application gets a sandboxed window of its own, with the cookies and
 * permissions of its branch only, no way to navigate TryMyDev elsewhere, and the overlay.
 */
function openWindow(url: string, overlay: OverlayOptions, key: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: overlay.label,
    icon: appIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#12131a',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: branchSession(key) }
  })
  window.setMenuBarVisibility(false)
  confine(window.webContents, url)
  void window.loadURL(url)
  attachOverlay(window, overlay)
  return window
}
