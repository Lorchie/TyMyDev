import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { withLock } from '../lock'
import { request } from '../network'
import { runtimeDir, storeDir } from '../paths'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * Electron can run as Node, but not well enough: under ELECTRON_RUN_AS_NODE the
 * Electron 33 postinstall stalls inside @electron/get and exits 0 without
 * downloading its binary. A real Node makes every npm lifecycle script behave as
 * it does on a developer machine, and it is the same download for every app.
 */
const DEFAULT = '22.23.2'

/**
 * Digests of the DEFAULT archives, copied from nodejs.org/dist/v22.23.2/SHASUMS256.txt:
 * the Node shipped by default is checked against what was reviewed, not only against the
 * server that serves it. Other versions are checked against SHASUMS256.txt.
 */
const DEFAULT_SHA256: Record<string, string> = {
  'win-x64': '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
  'win-arm64': 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3',
  'darwin-x64': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
  'darwin-arm64': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  'linux-x64': 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
  'linux-arm64': '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30'
}

type Wanted = { exact: string } | { major: string }

/**
 * What a manifest or an `engines` field asks for. An exact version is taken as is.
 * Anything else — "20", "20.x", "^20.17", ">=18" — names a major line: the version
 * we ship when it satisfies the request, otherwise the latest release of that line.
 * Never "20.0.0": the npm we ship requires Node 20.17 or later.
 */
function wanted(version?: string): Wanted {
  const clean = (version ?? '').trim().replace(/^v/, '')
  if (/^\d+\.\d+\.\d+$/.test(clean)) return { exact: clean }
  const major = clean.match(/\d+/)?.[0]
  const ours = DEFAULT.split('.')[0]
  const atLeast = clean.startsWith('>') && !clean.includes('<')
  if (!major || major === ours || (atLeast && Number(ours) >= Number(major))) {
    return { exact: DEFAULT }
  }
  return { major }
}

function slug(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win-${arch}`
  if (process.platform === 'darwin') return `darwin-${arch}`
  return `linux-${arch}`
}

export interface NodeRuntime {
  id: string
  bin: string
  /** Directory holding the binary, to put on PATH. */
  dir: string
}

function layout(version: string): NodeRuntime {
  const id = `node-${version}-${slug()}`
  const dir = runtimeDir('node', id)
  const bin = process.platform === 'win32' ? join(dir, 'node.exe') : join(dir, 'bin', 'node')
  return { id, bin, dir: process.platform === 'win32' ? dir : join(dir, 'bin') }
}

/** The runtime already on disk, or null. Never touches the network. */
export function cachedNode(version?: string): NodeRuntime | null {
  const want = wanted(version)
  const exact = 'exact' in want ? want.exact : newestInstalled(want.major)
  if (!exact) return null
  const rt = layout(exact)
  return existsSync(rt.bin) ? rt : null
}

/** Highest complete release of a major line already on disk. */
function newestInstalled(major: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(join(storeDir(), 'node'))
  } catch {
    return undefined
  }
  const pattern = new RegExp(`^node-(${major}\\.\\d+\\.\\d+)-${slug()}$`)
  return names
    .map((name) => name.match(pattern)?.[1])
    .filter((version): version is string => version !== undefined && existsSync(layout(version).bin))
    .sort((a, b) => {
      const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
    .pop()
}

/** Latest release of a major line, from the index nodejs.org publishes newest first. */
async function latestOf(major: string): Promise<string> {
  const res = await request('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`Could not list the Node.js releases (HTTP ${res.status}).`)
  const releases = (await res.json()) as { version: string }[]
  const release = releases.find((r) => r.version.startsWith(`v${major}.`))
  if (!release) throw new Error(`Node.js ${major} does not exist.`)
  return release.version.slice(1)
}

export async function ensureNode(version: string | undefined, log: BranchLog): Promise<NodeRuntime> {
  const cached = cachedNode(version)
  if (cached) return cached

  const want = wanted(version)
  const resolved = 'exact' in want ? want.exact : await latestOf(want.major)
  const rt = layout(resolved)

  return withLock(`runtime:${rt.id}`, async () => {
    if (existsSync(rt.bin)) return rt

    const isZip = process.platform === 'win32'
    const name = `node-v${resolved}-${slug()}`
    const file = `${name}.${isZip ? 'zip' : 'tar.gz'}`
    log.line(`[runtime] Node ${resolved} (${slug()})`)

    const pinned = resolved === DEFAULT ? DEFAULT_SHA256[slug()] : undefined
    await fetchArchive({
      url: `https://nodejs.org/dist/v${resolved}/${file}`,
      dest: runtimeDir('node', rt.id),
      checksum: pinned ? { value: pinned } : { url: `https://nodejs.org/dist/v${resolved}/SHASUMS256.txt`, file },
      strip: 1,
      log
    })

    if (!existsSync(rt.bin)) throw new Error(`Node runtime missing after extraction: ${rt.bin}`)
    log.line(`[runtime] Node ready: ${rt.bin}`)
    return rt
  })
}
