import { copyFileSync, existsSync, readFileSync, renameSync } from 'fs'
import { rename } from 'fs/promises'
import { writeJson } from './fsx'
import { branchDir, registryBackupPath, registryPath } from './paths'
import { branchKey } from './source-url'
import type { App, Branch, Manifest, Source } from './types'

interface RegistryFile {
  apps: App[]
  branches: Branch[]
}

/**
 * No registry yet is an empty one; an unreadable registry is not. Taken for empty, the next
 * write would lose every application and its approvals, and Storage would offer every
 * folder — shared models included — for deletion.
 */
function read(): RegistryFile {
  let text: string
  try {
    text = readFileSync(registryPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { apps: [], branches: [] }
    throw err
  }
  try {
    return parse(text)
  } catch (err) {
    throw new Error(
      `${registryPath()} is unreadable (${(err as Error).message}). It was left untouched, and nothing is ` +
        `deleted meanwhile: ${existsSync(registryBackupPath()) ? 'TryMyDev offers its previous version' : 'remove it to start over'}.`
    )
  }
}

function parse(text: string): RegistryFile {
  const file = JSON.parse(text) as Partial<RegistryFile>
  if (!Array.isArray(file.apps) || !Array.isArray(file.branches)) throw new Error('unexpected content')
  return file as RegistryFile
}

/** Before each change, the registry as it was is kept: one step back if anything goes wrong. */
function write(file: RegistryFile): void {
  if (existsSync(registryPath())) copyFileSync(registryPath(), registryBackupPath())
  writeJson(registryPath(), file)
}

/** Why the registry cannot be read, or nothing when it can. */
export function problem(): Error | undefined {
  try {
    read()
    return undefined
  } catch (err) {
    return err as Error
  }
}

/** Whether a readable previous version is there to restore. */
export function backupReadable(): boolean {
  try {
    parse(readFileSync(registryBackupPath(), 'utf-8'))
    return true
  } catch {
    return false
  }
}

/** The previous version takes the place of an unreadable registry, which is kept beside it. */
export function restoreBackup(): string {
  const broken = `${registryPath()}.broken-${Date.now()}`
  if (existsSync(registryPath())) renameSync(registryPath(), broken)
  copyFileSync(registryBackupPath(), registryPath())
  read()
  return broken
}

export function apps(): App[] {
  return read().apps
}

export function branches(appId?: string): Branch[] {
  const all = read().branches
  return appId ? all.filter((b) => b.appId === appId) : all
}

export function getApp(appId: string): App {
  const app = read().apps.find((a) => a.id === appId)
  if (!app) throw new Error(`Unknown application: ${appId}`)
  return app
}

export function getBranch(key: string): Branch {
  const branch = read().branches.find((b) => b.key === key)
  if (!branch) throw new Error(`Unknown branch: ${key}`)
  return branch
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** One application per upstream repository, `owner/repo`: its forks and pull requests land under it. */
export function addApp(repo: string, manifest?: Manifest): App {
  const file = read()
  const id = slug(repo)
  // The id names a folder: "." or ".." would put the application beside the others.
  if (!/[a-z0-9]/.test(id)) throw new Error(`Not a repository: ${repo}`)
  const existing = file.apps.find((a) => a.id === id)
  if (existing) {
    // A newer manifest replaces the old one. Approvals follow content, so it is
    // reviewed again unless it is identical to one already approved.
    if (manifest) existing.manifest = manifest
    existing.repo ??= repo
    write(file)
    return existing
  }

  const app: App = {
    id,
    name: manifest?.name ?? repo.slice(repo.indexOf('/') + 1),
    repo,
    manifest,
    addedAt: new Date().toISOString()
  }
  write({ ...file, apps: [...file.apps, app] })
  return app
}

/** The tester's folder for `id`, or back to the detected or default one without `path`. */
export function setFolder(appId: string, id: string, path: string | undefined): void {
  const file = read()
  const app = file.apps.find((a) => a.id === appId)
  if (!app) throw new Error(`Unknown application: ${appId}`)
  const folders = { ...app.folders }
  if (path) folders[id] = path
  else delete folders[id]
  if (Object.keys(folders).length > 0) app.folders = folders
  else delete app.folders
  write(file)
}

/** `owner/repo` of the code a branch runs — what an approval trusts. */
export function codeSource(src: Source): string {
  return `${src.owner}/${src.repo}`.toLowerCase()
}

/**
 * A manifest runs without asking only on code from a repository it was approved for:
 * approving Modly once must not let a stranger's fork of it run unseen, even with the
 * very same commands. Branches and new commits of that repository need no new approval.
 */
export function isApproved(app: App, manifestHash: string, src: Source): boolean {
  const source = codeSource(src)
  if (app.approvals?.some((a) => a.hash === manifestHash && a.source === source)) return true
  // Earlier versions recorded bare hashes, given for the upstream repository.
  return (app.approvedHashes?.includes(manifestHash) ?? false) && source === app.repo?.toLowerCase()
}

export function approveApp(appId: string, manifestHash: string, src: Source): void {
  const file = read()
  const app = file.apps.find((a) => a.id === appId)
  if (!app || isApproved(app, manifestHash, src)) return
  app.approvals = [...(app.approvals ?? []), { hash: manifestHash, source: codeSource(src) }]
  write(file)
}

/** GitHub ignores the case of owners and repositories; refs are exact. */
function sameSource(a: Source, b: Source): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.ref === b.ref
  )
}

/** A fork is the same application under another repository, not a new entry. */
export function addBranch(appId: string, src: Source): Branch {
  const file = read()
  // By source, not by key: a branch registered under an older key is the same branch.
  const existing = file.branches.find((b) => b.appId === appId && sameSource(b, src))
  if (existing) return existing

  const branch: Branch = { ...src, key: branchKey(appId, src), appId, addedAt: new Date().toISOString() }
  write({ ...file, branches: [...file.branches, branch] })
  return branch
}

export function removeBranch(key: string): void {
  const file = read()
  write({ ...file, branches: file.branches.filter((b) => b.key !== key) })
}

export function removeApp(appId: string): void {
  const file = read()
  write({
    apps: file.apps.filter((a) => a.id !== appId),
    branches: file.branches.filter((b) => b.appId !== appId)
  })
}

/**
 * Earlier versions spelled owner, repository and ref out in branch keys, and paths grew
 * past what Windows allows. Folders move to the short keys at startup; one still in use —
 * an application running from it — moves on a later start. Returns how many moved.
 */
export async function migrateKeys(
  onHold?: (folder: string, err: NodeJS.ErrnoException) => void
): Promise<number> {
  const file = read()
  let moved = 0
  for (const branch of file.branches) {
    const key = branchKey(branch.appId, branch)
    if (branch.key === key) continue
    const from = branchDir(branch.appId, branch.key)
    try {
      if (existsSync(from)) await rename(from, branchDir(branch.appId, key))
      branch.key = key
      moved++
    } catch (err) {
      onHold?.(from, err as NodeJS.ErrnoException)
    }
  }
  if (moved > 0) write(file)
  return moved
}

export function label(branch: Branch): string {
  return `${branch.owner}/${branch.repo} · ${branch.ref}${branch.pr ? ` (PR #${branch.pr})` : ''}`
}
