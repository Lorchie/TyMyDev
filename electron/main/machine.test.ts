import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cudaIndex, machine, matches, parseNvidiaSmi, type Machine } from './machine'

describe('matches', () => {
  const pc: Machine = { platform: 'windows', gpu: 'nvidia' }

  it('lets a step without conditions run everywhere', () => {
    assert.equal(matches(undefined, pc), true)
    assert.equal(matches({}, pc), true)
  })

  it('requires every condition given to match, each one or any of a list', () => {
    assert.equal(matches({ gpu: 'nvidia' }, pc), true)
    assert.equal(matches({ gpu: 'amd' }, pc), false)
    assert.equal(matches({ gpu: 'nvidia', platform: 'linux' }, pc), false)
    assert.equal(matches({ gpu: ['amd', 'nvidia'], platform: ['windows', 'macos'] }, pc), true)
  })
})

describe('machine', () => {
  it('names the platform the way manifests do', () => {
    const expected = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    assert.equal(machine().platform, expected)
  })

  it('lets TRYMYDEV_GPU force the GPU', () => {
    try {
      for (const gpu of ['nvidia', 'amd', 'none'] as const) {
        process.env.TRYMYDEV_GPU = gpu
        assert.equal(machine().gpu, gpu)
      }
    } finally {
      delete process.env.TRYMYDEV_GPU
    }
  })

  it('detects a GPU kind by itself otherwise', () => {
    assert.ok(['nvidia', 'amd', 'none'].includes(machine().gpu))
  })
})

describe('cudaIndex', () => {
  const index = (driver: number | undefined, computeCap?: number): string =>
    cudaIndex({ driver, computeCap }).split('/').pop() ?? ''

  it('takes CUDA 13 builds for Turing and later on a 580 driver', () => {
    assert.equal(index(591.86, 12.0), 'cu130')
    assert.equal(index(580.65, 7.5), 'cu130')
    assert.equal(index(581.2), 'cu130', 'without a compute capability, the driver decides')
  })

  it('keeps GPUs older than Turing, and drivers older than 580, on CUDA 12.6 builds', () => {
    assert.equal(index(591.86, 6.1), 'cu126', 'Pascal')
    assert.equal(index(591.86, 7.0), 'cu126', 'Volta')
    assert.equal(index(566.36, 8.9), 'cu126', 'Ada on an older driver')
    assert.equal(index(undefined), 'cu126', 'nvidia-smi gave nothing')
  })

  it('gives Blackwell on an older driver the CUDA 12.8 builds, the first that know it', () => {
    assert.equal(index(572.16, 12.0), 'cu128')
  })

  it('reads nvidia-smi, keeping the oldest of several GPUs', () => {
    assert.deepEqual(parseNvidiaSmi('591.86, 12.0\r\n591.86, 6.1\r\n'), { driver: 591.86, computeCap: 6.1 })
    assert.deepEqual(parseNvidiaSmi('472.12\n'), { driver: 472.12, computeCap: undefined })
    assert.deepEqual(parseNvidiaSmi('Failed to initialize NVML'), {})
  })
})
