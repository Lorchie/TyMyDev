import { copyFileSync, linkSync, mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { removeTree } from './fsx'
import { runtimeDir } from './paths'

export { isAlive } from './proc'

// Helpers for the *.test.ts files — never imported by the application.

export function tempDir(prefix = 'trymydev-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Points the Electron stub's userData at a fresh directory for this test file. */
export function useUserData(): string {
  const dir = tempDir('trymydev-data-')
  process.env.TRYMYDEV_USER_DATA = dir
  return dir
}

export async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await removeTree(dir)
}

export async function until(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

export const platformSlug = `${
  process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

/** Puts the Node running the tests where the runtime store expects Node `version`. */
export function installFakeNode(version: string): string {
  const dir = runtimeDir('node', `node-${version}-${platformSlug}`)
  const bin = process.platform === 'win32' ? join(dir, 'node.exe') : join(dir, 'bin', 'node')
  mkdirSync(dirname(bin), { recursive: true })
  try {
    linkSync(process.execPath, bin)
  } catch {
    copyFileSync(process.execPath, bin)
  }
  return bin
}
