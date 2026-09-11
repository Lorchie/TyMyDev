import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import * as tar from 'tar'
import { fileDigest, moveDir, removePath } from '../fsx'
import { download, request } from '../network'
import { tmpDir } from '../paths'
import { PRODUCT } from '../types'
import type { BranchLog } from '../logger'

const execFileAsync = promisify(execFile)
const UA = { 'User-Agent': PRODUCT.name.toLowerCase() }

export interface FetchOptions {
  url: string
  /** Final directory. Filled atomically: either complete or absent. */
  dest: string
  /** Expected sha256, or a URL serving it (a bare digest or "<digest>  <name>" lines). */
  checksum: { url: string; file?: string } | { value: string }
  /** Leading path components to drop, like tar --strip-components. */
  strip?: number
  log: BranchLog
  onProgress?: (received: number, total: number) => void
}

/**
 * Downloads an archive, checks its digest, extracts it and only then puts it in
 * place. A runtime executed on the tester's machine is verified before it runs;
 * an interrupted download can never leave a half-extracted runtime behind.
 */
export async function fetchArchive(opts: FetchOptions): Promise<string> {
  const { url, dest, log } = opts
  await mkdir(tmpDir(), { recursive: true })

  const name = url.split('/').pop() ?? 'archive'
  const archive = join(tmpDir(), `${Date.now()}-${name}`)
  const staging = `${dest}.incoming`

  log.line(`[runtime] downloading ${url}`)
  try {
    await download(url, archive, {
      headers: UA,
      onProgress: opts.onProgress,
      accept: (res) => {
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) — ${url}`)
      }
    })
    await verify(archive, name, opts.checksum, log)

    await removePath(staging)
    await mkdir(staging, { recursive: true })
    await extract(archive, staging, opts.strip ?? 0)
    await moveDir(staging, dest)
  } finally {
    await unlink(archive).catch(() => undefined)
  }
  return dest
}

/** Fails closed: a runtime whose digest cannot be checked is never run. */
async function verify(
  archive: string,
  name: string,
  checksum: FetchOptions['checksum'],
  log: BranchLog
): Promise<void> {
  let expected: string | undefined
  if ('value' in checksum) {
    expected = checksum.value
  } else {
    const res = await request(checksum.url, { headers: UA })
    if (!res.ok) throw new Error(`Checksum unavailable (HTTP ${res.status}) — ${checksum.url}`)
    const text = await res.text()
    const wanted = checksum.file ?? name
    const line = text.split(/\r?\n/).find((l) => l.trim().endsWith(wanted)) ?? text
    expected = line.trim().split(/\s+/)[0]
  }

  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(`Unreadable checksum for ${name} — the download was rejected.`)
  }
  const actual = await fileDigest(archive)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${name}.\nexpected ${expected}\ngot      ${actual}\n` +
        'The download was rejected.'
    )
  }
  log.line('[runtime] checksum verified')
}

async function extract(archive: string, dest: string, strip: number): Promise<void> {
  if (archive.endsWith('.zip')) {
    // bsdtar ships with Windows 10+ and with macOS; it reads zip archives, and it
    // is pinned by path because Git for Windows puts a GNU tar on PATH that
    // refuses "C:\..." targets.
    const bsdtar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    const args = ['-xf', archive, '-C', dest]
    if (strip > 0) args.splice(2, 0, `--strip-components=${strip}`)
    await execFileAsync(bsdtar, args)
    return
  }
  await tar.x({ file: archive, cwd: dest, strip })
}

/** Finds an executable a few levels down, for archives whose shape is not fixed. */
export async function findBinary(dir: string, name: string): Promise<string | undefined> {
  const direct = join(dir, name)
  if (existsSync(direct)) return direct

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = join(dir, entry.name, name)
    if (existsSync(nested)) return nested
  }
  return undefined
}
