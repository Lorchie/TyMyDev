import { existsSync, readFileSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { readJson, removePath, removeTree } from './fsx'
import { withLock } from './lock'
import {
  CACHE_TOOLS,
  appDir,
  appSharedDir,
  appsDir,
  branchDir,
  cacheDir,
  rootDir,
  shortDir,
  shortOwnerPath,
  shortRoot,
  statePath,
  storeDir,
  venvStore
} from './paths'
import * as registry from './registry'
import type { BranchState } from './types'

export interface UsageEntry {
  label: string
  path: string
  bytes: number
  /** True when nothing references it any more and it can be removed safely. */
  orphan: boolean
}

export interface PruneOptions {
  /** Download caches too — only when nothing is installing from them. */
  caches?: boolean
}

/** Environment stores, with the lock their writers take. */
const STORES = [
  { dir: 'node-deps', lock: 'node-deps', kind: 'node', name: 'Node dependencies' },
  { dir: 'venvs', lock: 'venv', kind: 'python', name: 'Python environments' }
] as const

interface Leftover {
  label: string
  path: string
  appId: string
  /** Set for a branch folder; absent for a whole application. */
  key?: string
}

async function sizeOf(path: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    // Links point into the shared stores; counting them would report the same
    // gigabytes once per branch.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await sizeOf(child)
    else {
      try {
        total += (await stat(child)).size
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total
}

function referencedKeys(): { node: Set<string>; python: Set<string> } {
  const node = new Set<string>()
  const python = new Set<string>()
  for (const branch of registry.branches()) {
    const state = readJson<BranchState>(statePath(branch.appId, branch.key), {})
    if (state.nodeKey) node.add(state.nodeKey)
    if (state.pythonKey) python.add(state.pythonKey)
  }
  return { node, python }
}

/** Folders of applications and branches that are no longer registered. */
async function leftovers(): Promise<Leftover[]> {
  const apps = new Map(registry.apps().map((a) => [a.id, a]))
  const keys = new Set(registry.branches().map((b) => b.key))
  const found: Leftover[] = []

  // Short folders sit outside the profile, beside those of its other profiles and of
  // the tests: only one this profile claimed is ever its to remove.
  for (const name of existsSync(shortRoot()) ? await readdir(shortRoot()) : []) {
    const path = join(shortRoot(), name)
    const owner = readJson<{ root?: string; appId?: string }>(shortOwnerPath(path), {})
    if (owner.root === rootDir() && owner.appId && !apps.has(owner.appId)) {
      found.push({ label: `Removed application · ${owner.appId} · short-path folder`, path, appId: owner.appId })
    }
  }

  for (const id of existsSync(appsDir()) ? await readdir(appsDir()) : []) {
    const app = apps.get(id)
    if (!app) {
      found.push({ label: `Removed application · ${id}`, path: appDir(id), appId: id })
      continue
    }
    const base = join(appDir(id), 'branches')
    if (!existsSync(base)) continue
    for (const key of await readdir(base)) {
      if (keys.has(key)) continue
      found.push({ label: `${app.name} · removed branch ${key}`, path: branchDir(id, key), appId: id, key })
    }
  }
  return found
}

function stillRegistered(leftover: Leftover): boolean {
  return leftover.key
    ? registry.branches().some((b) => b.key === leftover.key)
    : registry.apps().some((a) => a.id === leftover.appId)
}

/**
 * The Python runtime of earlier versions, which TryMyDev downloaded itself before uv
 * did. Environments built on it name it in their pyvenv.cfg; it stays while one does.
 */
function legacyPython(): { path: string; used: boolean } | undefined {
  const path = join(storeDir(), 'python')
  if (!existsSync(path)) return undefined
  const used = [...referencedKeys().python].some((key) => {
    try {
      return readFileSync(join(venvStore(key), 'pyvenv.cfg'), 'utf-8').includes(path)
    } catch {
      return false
    }
  })
  return { path, used }
}

/** What the tool occupies, and what part of it nothing needs any more. */
export async function usage(): Promise<UsageEntry[]> {
  const referenced = referencedKeys()
  const entries: UsageEntry[] = []

  for (const app of registry.apps()) {
    const branchList = registry.branches(app.id)
    for (const branch of branchList) {
      entries.push({
        label: `${app.name} · ${branch.ref}`,
        path: branchDir(app.id, branch.key),
        bytes: await sizeOf(branchDir(app.id, branch.key)),
        orphan: false
      })
    }
    const shared = appSharedDir(app.id)
    if (existsSync(shared)) {
      entries.push({
        label: `${app.name} · shared data`,
        path: shared,
        bytes: await sizeOf(shared),
        orphan: branchList.length === 0
      })
    }
    const short = shortDir(app.id)
    if (existsSync(short)) {
      entries.push({
        label: `${app.name} · short-path folder`,
        path: short,
        bytes: await sizeOf(short),
        orphan: branchList.length === 0
      })
    }
  }

  for (const leftover of await leftovers()) {
    entries.push({ label: leftover.label, path: leftover.path, bytes: await sizeOf(leftover.path), orphan: true })
  }

  for (const store of STORES) {
    const base = join(storeDir(), store.dir)
    if (!existsSync(base)) continue
    for (const key of await readdir(base)) {
      entries.push({
        label: `${store.name} · ${key.slice(0, 8)}`,
        path: join(base, key),
        bytes: await sizeOf(join(base, key)),
        orphan: !referenced[store.kind].has(key)
      })
    }
  }

  // Nothing installed depends on a download cache: uv hardlinks what it installs.
  for (const tool of CACHE_TOOLS) {
    const dir = cacheDir(tool)
    if (existsSync(dir)) {
      entries.push({ label: `Download cache · ${tool}`, path: dir, bytes: await sizeOf(dir), orphan: true })
    }
  }

  const legacy = legacyPython()
  if (legacy) {
    entries.push({
      label: 'Runtime · Python (earlier version)',
      path: legacy.path,
      bytes: await sizeOf(legacy.path),
      orphan: !legacy.used
    })
  }

  for (const kind of ['node', 'pythons', 'uv'] as const) {
    const base = join(storeDir(), kind)
    if (!existsSync(base)) continue
    for (const entry of await readdir(base, { withFileTypes: true })) {
      // uv links "cpython-3.13" to the latest 3.13.x: counted once, under its real name.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      entries.push({
        label: `Runtime · ${entry.name}`,
        path: join(base, entry.name),
        bytes: await sizeOf(join(base, entry.name)),
        orphan: false
      })
    }
  }

  return entries.sort((a, b) => b.bytes - a.bytes)
}

/**
 * Removes the environments nothing points at any more, and the folders of removed
 * applications and branches. Runtimes are kept on purpose: they belong to no
 * application and the next one will want them. One prune runs at a time.
 */
export function prune(options: PruneOptions = {}): Promise<number> {
  return withLock('prune', async () => {
    let removed = 0

    for (const store of STORES) {
      const base = join(storeDir(), store.dir)
      if (!existsSync(base)) continue
      for (const key of await readdir(base)) {
        // Decided under the writers' lock, on references read again: a job records
        // its keys before it touches the store.
        await withLock(`${store.lock}:${key}`, async () => {
          if (referencedKeys()[store.kind].has(key)) return
          removed += await sizeOf(join(base, key))
          await removePath(join(base, key))
        })
      }
    }

    for (const leftover of await leftovers()) {
      // Looked at again right before deleting: it may have been added back meanwhile.
      if (stillRegistered(leftover)) continue
      const bytes = await sizeOf(leftover.path)
      try {
        await removeTree(leftover.path)
        removed += bytes
      } catch {
        /* still held by a process being stopped — the next prune takes it */
      }
    }

    const legacy = legacyPython()
    if (legacy && !legacy.used) {
      removed += await sizeOf(legacy.path)
      await removePath(legacy.path)
    }

    if (options.caches) {
      for (const tool of CACHE_TOOLS) {
        const dir = cacheDir(tool)
        if (!existsSync(dir)) continue
        removed += await sizeOf(dir)
        await removePath(dir)
      }
    }
    return removed
  })
}
