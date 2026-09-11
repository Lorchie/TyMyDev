import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { hashString } from './fsx'
import { PRODUCT } from './types'

/**
 * Windows puts Electron's profile in Roaming AppData, which a company network copies at
 * every logon: no place for gigabytes of runtimes and environments. A new profile goes to
 * Local AppData. One an earlier version created in Roaming stays there — its environments
 * hold absolute paths, and its encrypted token the key of that profile. Called before ready.
 */
export function chooseUserData(): void {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return
  if (app.commandLine.hasSwitch('user-data-dir')) return
  if (existsSync(join(app.getPath('userData'), 'registry.json'))) return
  app.setPath('userData', join(process.env.LOCALAPPDATA, PRODUCT.name))
}

/**
 * Three levels, and the distinction matters:
 *
 *   store/…                     runtimes, download caches and content-addressed environments —
 *                               global, because a Node 22 or a wheel of numpy 2.1 is the same
 *                               for everyone
 *   apps/<app>/shared/…         what only means something inside one application
 *   apps/<app>/branches/<key>/  one branch: sources, data, logs, state
 */
export const rootDir = (): string => app.getPath('userData')

export const appsDir = (): string => join(rootDir(), 'apps')
export const appDir = (appId: string): string => join(appsDir(), appId)
export const appSharedDir = (appId: string): string => join(appDir(appId), 'shared')
/** App-wide copy of a `share` path: `resources/python-embed` → `shared/resources-python-embed`. */
export const appShared = (appId: string, sharePath: string): string =>
  join(appSharedDir(appId), sharePath.replace(/[\\/]+/g, '-'))

export const branchDir = (appId: string, key: string): string =>
  join(appDir(appId), 'branches', key)
export const checkoutDir = (appId: string, key: string): string =>
  join(branchDir(appId, key), 'checkout')
export const branchDataDir = (appId: string, key: string): string =>
  join(branchDir(appId, key), 'data')
export const logsDir = (appId: string, key: string): string => join(branchDir(appId, key), 'logs')
export const statePath = (appId: string, key: string): string =>
  join(branchDir(appId, key), 'state.json')

/**
 * Python on Windows stops at 260 characters, and some trees it builds — an extension and
 * its torch venv — go 200 deep: they get a folder near the top of the home directory, one
 * per profile and application. TRYMYDEV_SHORT_ROOT moves it, to try a longer user name.
 */
export const shortRoot = (): string => process.env.TRYMYDEV_SHORT_ROOT ?? join(app.getPath('home'), '.tmd')
export const shortDir = (appId: string): string =>
  join(shortRoot(), hashString(`${rootDir()}|${appId}`).slice(0, 4))
/** Names the profile and application a short folder belongs to. */
export const shortOwnerPath = (dir: string): string => join(dir, 'owner.json')

export const storeDir = (): string => join(rootDir(), 'store')
export const tmpDir = (): string => join(storeDir(), 'tmp')
/** Node installs, keyed by lockfile hash and shaped like a real project. */
export const nodeCacheDir = (lockHash: string): string => join(storeDir(), 'node-deps', lockHash)
export const nodeModulesStore = (lockHash: string): string =>
  join(nodeCacheDir(lockHash), 'node_modules')
/** Python environments, keyed by the hash of the files that define them. */
export const venvStore = (reqHash: string): string => join(storeDir(), 'venvs', reqHash)
export const runtimeDir = (kind: string, id: string): string => join(storeDir(), kind, id)
/** One shim directory per runtime: two apps on different Node versions never collide. */
export const shimDir = (runtimeId: string): string => join(storeDir(), 'shims', runtimeId)
/** Python installations, managed by uv. */
export const pythonsDir = (): string => join(storeDir(), 'pythons')

/** Download caches of the tools TryMyDev runs — in the store, where Storage sees them. */
export const CACHE_TOOLS = ['uv', 'npm', 'pip', 'electron'] as const
export type CacheTool = (typeof CACHE_TOOLS)[number]
export const cacheDir = (tool: CacheTool): string => join(storeDir(), 'cache', tool)

/**
 * The overlay's files. A tested Electron application loads them in its own process, from
 * these absolute paths; while developing, the page comes from the dev server.
 */
export function overlayFiles(): { page: string; preload: string; inject: string } {
  const out = join(app.getAppPath(), 'out')
  const devServer = process.env['ELECTRON_RENDERER_URL']
  return {
    page: devServer ? `${devServer}/overlay.html` : join(out, 'renderer', 'overlay.html'),
    preload: join(out, 'preload', 'overlay.js'),
    inject: join(out, 'main', 'inject.js')
  }
}
/**
 * TryMyDev's icon for its windows, packaged beside the code: Windows takes every size from the
 * .ico, Linux has no executable icon to fall back on. macOS uses the bundle's .icns.
 */
export const appIcon = (): string =>
  join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

/** Where the overlay button sits in an application's windows, shared by its branches. */
export const overlaySettingsPath = (appId: string): string => join(appDir(appId), 'overlay.json')

export const registryPath = (): string => join(rootDir(), 'registry.json')
/** The registry as it was before its last change. */
export const registryBackupPath = (): string => join(rootDir(), 'registry.backup.json')
export const etagsPath = (): string => join(storeDir(), 'github-etags.json')
export const settingsPath = (): string => join(rootDir(), 'settings.json')
/** TryMyDev's own log, for what fails outside any branch. */
export const appLogPath = (): string => join(rootDir(), 'logs', 'main.log')
