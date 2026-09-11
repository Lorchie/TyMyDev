import { createHash } from 'crypto'
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { chmod, cp, lstat, mkdir, readdir, realpath, rename, rm, symlink, unlink } from 'fs/promises'
import { dirname, join } from 'path'

/**
 * What an antivirus scanning a file just written, or an indexer, answers for a moment.
 * The operation succeeds a little later; failing at once breaks installs on some machines only.
 */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRIES = 12

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code

/** Small JSON reads and writes stay synchronous: they are always tiny. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/**
 * Written beside the file, then renamed over it: a full disk or a crash halfway through
 * leaves the previous content whole instead of an empty file.
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf-8')
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, path)
        return
      } catch (err) {
        if (!BUSY.has(codeOf(err) ?? '') || attempt === RETRIES) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * attempt)
      }
    }
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* the error that matters is the write's */
    }
    throw err
  }
}

/** A rename retried while another program still holds a file inside. */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (!BUSY.has(codeOf(err) ?? '') || attempt === RETRIES) throw err
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
}

export function hashString(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Streamed so a large lockfile never blocks the UI thread. */
export async function sha256File(path: string, length = 16): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex').slice(0, length)
}

export async function fileDigest(path: string): Promise<string> {
  return sha256File(path, 64)
}

/** Removes a path without ever following a link into the shared stores. */
export async function removePath(path: string): Promise<void> {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * Deletes a checkout, a branch or an application: every link inside is removed
 * first, so the recursive delete can never reach the shared stores behind them.
 */
export async function removeTree(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isDirectory()) await unlinkLinks(path)
  await removePath(path)
}

async function unlinkLinks(dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isSymbolicLink()) await unlink(child)
    else if (entry.isDirectory()) await unlinkLinks(child)
  }
}

/**
 * Points `link` at `target`. Junctions on Windows (no administrator rights needed),
 * plain directory symlinks elsewhere. Re-created when it points somewhere else.
 */
export async function linkDir(link: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  await mkdir(dirname(link), { recursive: true })

  // lstat, not existsSync: a dangling link — its store deleted, userData moved —
  // "does not exist", yet still stands in the way of the new one.
  if (await lstat(link).catch(() => undefined)) {
    try {
      if ((await realpath(link)) === (await realpath(target))) return
    } catch {
      /* dangling link — fall through and re-create it */
    }
    await removePath(link)
  }
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Move a directory, falling back to a copy when the stores sit on another volume. */
export async function moveDir(from: string, to: string): Promise<void> {
  await removePath(to)
  await mkdir(dirname(to), { recursive: true })
  try {
    await renameRetrying(from, to)
  } catch (err) {
    if (codeOf(err) !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, verbatimSymlinks: true })
    await removePath(from)
  }
}

export async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  if (process.platform !== 'win32') await chmod(path, 0o755)
}
