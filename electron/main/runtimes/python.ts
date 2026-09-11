import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { withLock } from '../lock'
import { pythonsDir, runtimeDir } from '../paths'
import { capture, run, type RunContext } from '../proc'
import { fetchArchive, findBinary } from './download'
import type { BranchLog } from '../logger'

/** The Python a manifest gets when it names none. */
const PY_DEFAULT = '3.12'
/** uv installs each wheel once and hardlinks it into every environment. */
const UV_VERSION = '0.12.12'

/** Digests of the uv 0.12.12 archives, copied from the `.sha256` files of its GitHub release. */
const UV_SHA256: Record<string, string> = {
  'x86_64-pc-windows-msvc': '3d54912924c36e862c14f427d04f2ed70a99e8001d1c30caa101f6d5711626d5',
  'aarch64-pc-windows-msvc': '36559da51ecee83b2b1d80aa1a0ede2f80e2d9e5761fffcbb9e9366a7f3d022a',
  'x86_64-apple-darwin': '0dc8cd6c961582b0d140b5398f96b23502885277fb3464241456a2435e460dfa',
  'aarch64-apple-darwin': '46740540b63fdee9a6cb2e19baf3f1f475b850c440a33e63455087a6871263f1',
  'x86_64-unknown-linux-gnu': 'ab9b309d4586403f024e100abaceb396616e178a553e2500c36087d180f09509',
  'aarch64-unknown-linux-gnu': 'fe08db50cc1b56cd1da7801065ed1103d27ed3f9571cd122386cfc7faf1b8df5'
}

/** Target triple of the uv release archives. */
function triple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  return `${arch}-unknown-linux-gnu`
}

export interface PythonRuntime {
  /** Exact version, e.g. "cpython-3.13.7": environments built on it are keyed by it. */
  id: string
  bin: string
  dir: string
}

/** "3.13.7", "3.13" or "3.13.x", as uv expects them. */
function request(version: string | undefined): string {
  return (version ?? PY_DEFAULT).trim().replace(/^v/, '').replace(/\.x$/, '')
}

/**
 * uv installs python-build-standalone builds — complete, relocatable and checked
 * against the digests uv ships with — into the store, and resolves "3.13" to its
 * latest release. Only those installations count: the tester's own Python, or a
 * virtual environment they activated, never leaks in.
 */
export async function ensurePython(
  version: string | undefined,
  uvBin: string,
  log: BranchLog,
  proxy?: string
): Promise<PythonRuntime> {
  const wanted = request(version)
  await mkdir(pythonsDir(), { recursive: true })
  const ctx: RunContext = { toolchain: { pathDirs: [], uvBin, proxy }, cwd: pythonsDir(), log }

  const installed = await findPython(wanted, ctx)
  if (installed) return installed

  return withLock(`runtime:python-${wanted}`, async () => {
    const meanwhile = await findPython(wanted, ctx)
    if (meanwhile) return meanwhile

    log.line(`[runtime] Python ${wanted}`)
    await run(`uv python install ${wanted}`, ctx)
    const ready = await findPython(wanted, ctx)
    if (!ready) throw new Error(`Python ${wanted} is missing after its installation.`)
    log.line(`[runtime] Python ready: ${ready.bin} (${ready.id})`)
    return ready
  })
}

async function findPython(wanted: string, ctx: RunContext): Promise<PythonRuntime | null> {
  let bin: string
  try {
    // Not finding it is the expected answer before the first install: kept out of the log.
    bin = (await capture(`uv python find ${wanted} --offline`, ctx, { quiet: true })).trim().split(/\r?\n/).pop() ?? ''
  } catch {
    return null
  }
  if (!existsSync(bin)) return null
  const version = (await capture(`"${bin}" -c "import platform; print(platform.python_version())"`, ctx)).trim()
  return { id: `cpython-${version}`, bin, dir: dirname(bin) }
}

/**
 * uv keeps one global wheel cache and hardlinks packages into each environment,
 * so a branch that changes a single dependency gets a complete, correct venv
 * without paying for it twice on disk — the reason we do not stack venvs.
 */
export async function ensureUv(log: BranchLog): Promise<string> {
  const id = `uv-${UV_VERSION}-${triple()}`
  const dir = runtimeDir('uv', id)
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const existing = existsSync(dir) ? await findBinary(dir, name) : undefined
  if (existing) return existing

  return withLock(`runtime:${id}`, async () => {
    const already = existsSync(dir) ? await findBinary(dir, name) : undefined
    if (already) return already

    const isZip = process.platform === 'win32'
    const file = `uv-${triple()}.${isZip ? 'zip' : 'tar.gz'}`
    const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
    log.line(`[runtime] uv ${UV_VERSION}`)

    await fetchArchive({
      url: `${base}/${file}`,
      dest: dir,
      checksum: UV_SHA256[triple()] ? { value: UV_SHA256[triple()] } : { url: `${base}/${file}.sha256` },
      log
    })

    const bin = await findBinary(dir, name)
    if (!bin) throw new Error(`uv binary missing after extraction in ${dir}`)
    log.line(`[runtime] uv ready: ${bin}`)
    return bin
  })
}
