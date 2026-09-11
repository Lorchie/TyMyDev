import { app as electronApp } from 'electron'
import { existsSync } from 'fs'
import { isAbsolute, normalize, parse, relative, resolve } from 'path'
import { readJson } from './fsx'
import { resolveManifest } from './manifest'
import { appSharedDir, checkoutDir, rootDir, shortDir, shortRoot } from './paths'
import { builtinFor } from './profiles/builtin'
import * as registry from './registry'
import { expand, type SeedPlaces } from './seed'
import type { App, FolderSpec, Manifest } from './types'

/** TryMyDev's folder, the installed application's, or one the tester picked. */
export type FolderSource = 'own' | 'installed' | 'custom'

export interface FolderView {
  id: string
  label: string
  path: string
  source: FolderSource
  /** Switched by the tester, rather than the manifest's choice. */
  chosen: boolean
  /** The installed application's folder, when there is one to switch to. */
  installed?: string
}

/**
 * Where each folder of an application is, the same for every branch: the tester's switch, else
 * the manifest's choice — the installed application's folder falling back to TryMyDev's own
 * when that application is not installed.
 */
export async function resolveFolders(app: App, manifest: Manifest): Promise<FolderView[]> {
  const places: SeedPlaces = {
    checkout: '',
    data: '',
    shared: appSharedDir(app.id),
    short: shortDir(app.id),
    documents: electronApp.getPath('documents'),
    appData: electronApp.getPath('appData')
  }
  const views: FolderView[] = []
  for (const spec of manifest.folders ?? []) {
    const own = await expand(spec.own, places)
    const installed = spec.installed ? await installedFolder(spec.installed, places) : undefined
    const choice = app.folders?.[spec.id]
    const base = { id: spec.id, label: spec.label, ...(installed ? { installed } : {}) }

    if (choice && choice !== 'own' && choice !== 'installed') {
      views.push({ ...base, path: choice, source: 'custom', chosen: true })
    } else if (choice === 'installed' && spec.installed) {
      // Switched on purpose: an installed copy gone since is reported, not silently replaced.
      views.push({ ...base, path: installed ?? (await expand(spec.installed.usual, places)), source: 'installed', chosen: true })
    } else if (!choice && spec.use === 'installed' && installed) {
      views.push({ ...base, path: installed, source: 'installed', chosen: false })
    } else {
      views.push({ ...base, path: own, source: 'own', chosen: choice === 'own' })
    }
  }
  return views
}

/** The folder an installed copy's settings name — only an absolute path — else its usual one, if it is there. */
async function installedFolder(
  spec: NonNullable<FolderSpec['installed']>,
  places: SeedPlaces
): Promise<string | undefined> {
  const settings = readJson<Record<string, unknown> | null>(await expand(spec.file, places), null)
  const named = settings && typeof settings === 'object' ? settings[spec.key] : undefined
  if (typeof named === 'string' && isAbsolute(named)) return normalize(named)
  const usual = await expand(spec.usual, places)
  return existsSync(usual) ? usual : undefined
}

/**
 * Why a folder cannot be picked, or nothing: a whole disk mixes an application's files with
 * everything else on it, and TryMyDev deletes its own folders with a branch or an application.
 */
export function refusedFolder(path: string): string | undefined {
  const full = resolve(path)
  if (full === parse(full).root) {
    return `${full} is the root of a disk: the application would mix its files with everything else on it.`
  }
  for (const own of [rootDir(), shortRoot()]) {
    const inside = relative(own, full)
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      return `${full} belongs to TryMyDev, which deletes such folders along with a branch or an application. "Use TryMyDev" picks TryMyDev's own.`
    }
  }
  return undefined
}

/**
 * A folder the tester switched to that is gone — a drive not connected, an application
 * uninstalled — stops a start instead of being made anew, empty. TryMyDev's own is simply made.
 */
export function missingChosen(views: FolderView[]): FolderView | undefined {
  return views.find((view) => view.chosen && view.source !== 'own' && !existsSync(view.path))
}

export const folderPaths = (views: FolderView[]): Record<string, string> =>
  Object.fromEntries(views.map((view) => [view.id, view.path]))

/** The manifest an application's folders come from: a fetched branch's, else the one known without code. */
export function manifestOfApp(app: App): Manifest | undefined {
  for (const branch of registry.branches(app.id)) {
    const checkout = checkoutDir(app.id, branch.key)
    if (!existsSync(checkout)) continue
    try {
      return resolveManifest(checkout, app, branch)
    } catch {
      /* nothing to read in this checkout yet */
    }
  }
  return app.manifest ?? (app.repo ? builtinFor(app.repo) : undefined)
}
