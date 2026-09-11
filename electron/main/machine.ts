import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import type { Condition, Gpu, Platform } from './types'

const PYTORCH_INDEX = 'https://download.pytorch.org/whl'
/** PyTorch index of ROCm builds of torch, for AMD GPUs on Linux. */
export const ROCM_INDEX = `${PYTORCH_INDEX}/rocm7.2`

export interface Machine {
  platform: Platform
  gpu: Gpu
}

/** What nvidia-smi says: driver version and the lowest compute capability among the GPUs. */
export interface NvidiaInfo {
  driver?: number
  computeCap?: number
}

let detectedGpu: Gpu | undefined
let detectedNvidia: NvidiaInfo | undefined

/** This computer, in the words manifests use. TRYMYDEV_GPU forces the GPU. */
export function machine(): Machine {
  const forced = process.env.TRYMYDEV_GPU
  const gpu = forced === 'nvidia' || forced === 'amd' || forced === 'none' ? forced : (detectedGpu ??= detectGpu())
  return { platform: platformName(), gpu }
}

function platformName(): Platform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

function nvidiaSmi(): string | undefined {
  const exe = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'win32') dirs.push(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'))
  return dirs.map((dir) => join(dir, exe)).find((path) => existsSync(path))
}

/** The NVIDIA driver ships nvidia-smi; ROCm exposes /dev/kfd. Enough to choose a torch build. */
function detectGpu(): Gpu {
  if (nvidiaSmi()) return 'nvidia'
  if (process.platform === 'linux' && existsSync('/dev/kfd')) return 'amd'
  return 'none'
}

/** Parses `591.86, 12.0` lines; drivers older than compute_cap answer with the driver alone. */
export function parseNvidiaSmi(output: string): NvidiaInfo {
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => Number.parseFloat(cell.trim())))
    .filter(([driver]) => !Number.isNaN(driver))
  if (rows.length === 0) return {}
  const caps = rows.map((row) => row[1]).filter((cap): cap is number => cap !== undefined && !Number.isNaN(cap))
  return { driver: rows[0][0], computeCap: caps.length > 0 ? Math.min(...caps) : undefined }
}

/** Asked once: the driver does not change while TryMyDev runs. */
export function nvidiaInfo(): NvidiaInfo {
  if (detectedNvidia) return detectedNvidia
  const smi = nvidiaSmi()
  detectedNvidia = {}
  if (!smi) return detectedNvidia
  for (const query of ['driver_version,compute_cap', 'driver_version']) {
    try {
      const output = execFileSync(smi, [`--query-gpu=${query}`, '--format=csv,noheader'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true
      })
      detectedNvidia = parseNvidiaSmi(output)
      if (detectedNvidia.driver !== undefined) break
    } catch {
      /* an older nvidia-smi refuses compute_cap; a broken driver refuses everything */
    }
  }
  return detectedNvidia
}

/**
 * The PyTorch index of CUDA builds this machine can run. CUDA 13 needs a 580 driver and
 * leaves out GPUs older than Turing (compute capability 7.5). The CUDA 12.6 builds run on
 * any 525 driver, Pascal to Ada, but not on Blackwell (12.0), which needs CUDA 12.8 or later.
 * One index for every NVIDIA machine would install a torch that fails on part of them.
 */
export function cudaIndex(info: NvidiaInfo = nvidiaInfo()): string {
  const { driver = 0, computeCap } = info
  if (driver >= 580 && (computeCap === undefined || computeCap >= 7.5)) return `${PYTORCH_INDEX}/cu130`
  if (computeCap !== undefined && computeCap >= 12) return `${PYTORCH_INDEX}/cu128`
  return `${PYTORCH_INDEX}/cu126`
}

export function matches(when: Condition | undefined, on: Machine = machine()): boolean {
  if (!when) return true
  const accepts = <T>(wanted: T | T[] | undefined, actual: T): boolean =>
    wanted === undefined || (Array.isArray(wanted) ? wanted.includes(actual) : wanted === actual)
  return accepts(when.platform, on.platform) && accepts(when.gpu, on.gpu)
}
