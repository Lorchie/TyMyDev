import { clipboard, ipcMain, shell, type BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { appLog, errorText } from './applog'
import { rateLimit, resolveSource } from './github'
import * as jobs from './jobs'
import { validate } from './manifest'
import { appLogPath, logsDir } from './paths'
import { readState } from './provision'
import * as registry from './registry'
import { isRunning } from './runner'
import { forgetBranchSession, openExternalSafely, samePlace } from './security'
import { hasGithubToken, setGithubToken } from './settings'
import { createShortcut } from './shortcut'
import { parseInput } from './source-url'
import { prune, usage } from './storage'
import type { App, Branch, Manifest } from './types'

export interface BranchView extends Branch {
  label: string
  builtSha?: string
  url?: string
  running: boolean
  busy: boolean
}

export interface AppView extends App {
  branches: BranchView[]
}

function branchView(branch: Branch): BranchView {
  const state = readState(branch.appId, branch.key)
  return {
    ...branch,
    label: registry.label(branch),
    builtSha: state.builtSha,
    url: state.url,
    running: isRunning(branch.key),
    busy: jobs.busy(branch.key)
  }
}

function view(): AppView[] {
  return registry.apps().map((app) => ({
    ...app,
    branches: registry.branches(app.id).map(branchView)
  }))
}

/** Deleting gigabytes takes a while: the list updates at once, the disk follows. */
function cleanUpLater(): void {
  void prune().catch((err) => appLog(`[storage] cleanup failed: ${errorText(err)}`))
}

/** `home` is the page of the TryMyDev window: the only one allowed to call. */
export function registerIpc(getWindow: () => BrowserWindow | null, home: string): void {
  /**
   * Every call must come from the TryMyDev page in the TryMyDev window — never from a page
   * of a tested application, nor from another page loaded in that window — and is logged
   * when it fails: the window only ever sees the message.
   */
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (event.sender.id !== getWindow()?.webContents.id || !samePlace(event.senderFrame?.url ?? '', home)) {
          throw new Error(`Refused ${channel}: the call does not come from the TryMyDev window.`)
        }
        return await fn(...(args as A))
      } catch (err) {
        appLog(`[ipc] ${channel} failed: ${errorText(err)}`)
        throw err
      }
    })
  }

  handle('apps:list', () => view())

  /**
   * One thing to paste: a URL, optionally with the manifest the developer handed
   * over. The application is keyed on the upstream repository, so a fork lands
   * under the same entry instead of creating a second one.
   */
  handle('apps:add', async (input: string, manifestText?: string) => {
    let manifest: Manifest | undefined
    if (manifestText && manifestText.trim() !== '') {
      manifest = validate(manifestText, 'the manifest you pasted')
    }

    const { source, upstream } = await resolveSource(parseInput(input))
    const app = registry.addApp(manifest?.repo ?? upstream, manifest)
    registry.addBranch(app.id, source)
    return view()
  })

  handle('apps:remove', (appId: string) => {
    for (const branch of registry.branches(appId)) {
      jobs.cancel(branch.key)
      forgetBranchSession(branch.key)
    }
    registry.removeApp(appId)
    cleanUpLater()
    return view()
  })

  handle('branches:add', async (appId: string, input: string) => {
    const { source } = await resolveSource(parseInput(input))
    registry.addBranch(appId, source)
    return view()
  })

  handle('branches:remove', (key: string) => {
    jobs.cancel(key)
    forgetBranchSession(key)
    registry.removeBranch(key)
    cleanUpLater()
    return view()
  })

  handle('branches:start', async (key: string) => {
    const win = getWindow()
    if (win) await jobs.startBranch(win, key)
  })

  handle('branches:cancel', (key: string) => jobs.cancel(key))

  handle('branches:refresh', async () => {
    const win = getWindow()
    if (win) await jobs.refresh(win, registry.branches())
    return view()
  })

  handle('branches:shortcut', (key: string) => {
    const branch = registry.getBranch(key)
    return createShortcut(registry.getApp(branch.appId), branch)
  })

  /**
   * The tester accepted the commands they were shown; run them. The approval is for the
   * code of the branch's own repository, read here — never taken from the window.
   */
  handle('manifest:approve', async (appId: string, hash: string, key: string) => {
    const branch = registry.getBranch(key)
    if (branch.appId !== appId) throw new Error(`Refused: ${key} is not a branch of ${appId}.`)
    registry.approveApp(branch.appId, hash, branch)
    const win = getWindow()
    if (win) await jobs.startBranch(win, key)
  })

  handle('storage:usage', () => usage())
  // Download caches only go while nothing is installing from them.
  handle('storage:prune', () => prune({ caches: !jobs.installing() }))

  handle('settings:get', () => ({ githubToken: hasGithubToken() }))
  handle('settings:setGithubToken', async (token: string | null) => {
    if (!token?.trim()) {
      setGithubToken(undefined)
      return { githubToken: false }
    }
    const limit = await rateLimit(token.trim())
    setGithubToken(token)
    return { githubToken: true, limit }
  })

  // The folder is found from the registry, never built from what the window sends.
  handle('branches:openLogs', (_appId: string, key: string) => {
    const branch = registry.getBranch(key)
    return shell.openPath(logsDir(branch.appId, branch.key))
  })
  handle('app:openLog', () => {
    const path = appLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, '')
    return shell.openPath(path)
  })
  handle('app:reportError', (message: string) => appLog(`[window] ${message}`))
  // The window is sandboxed: the clipboard is reached through here.
  handle('app:copy', (text: string) => clipboard.writeText(text))
  handle('shell:showItem', (path: string) => shell.showItemInFolder(path))
  handle('shell:openExternal', (url: string) => openExternalSafely(url))
}
