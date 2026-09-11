import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { writeExecutable } from '../fsx'
import { shimDir } from '../paths'

/**
 * npm lifecycle scripts shell out to `node`, `npm` and `npx`; electron-vite's bin
 * shims do too. The tester has none of them, so we write wrappers and put them
 * first on PATH.
 *
 * One directory per runtime, deliberately: two applications on different Node
 * versions would otherwise rewrite each other's `node` wrapper mid-build.
 */
export function npmCliPath(): string {
  // Packaged, npm ships beside app.asar, copied as it is: the real Node that runs it
  // cannot read inside the archive, and packaging would scatter npm's bundled modules.
  const path = app.isPackaged
    ? join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js')
    : join(app.getAppPath(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(path)) throw new Error(`npm not found inside the application (${path}).`)
  return path
}

export async function ensureShims(runtimeId: string, nodeBin: string): Promise<string> {
  const dir = shimDir(runtimeId)
  const npmCli = npmCliPath()

  if (process.platform === 'win32') {
    // cmd.exe reads a batch file in the OEM code page of the system (850, 437…), not in
    // UTF-8: a path written into one breaks as soon as the user name has an accent. The
    // paths arrive in variables instead — see buildEnv — which cmd.exe reads as they are.

    // Git for Windows puts a GNU tar on PATH that reads "C:\..." as a remote host
    // and refuses every absolute path; pin the bsdtar that ships with Windows.
    const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(winTar)) await write(join(dir, 'tar.cmd'), '@echo off\r\n"%SystemRoot%\\System32\\tar.exe" %*\r\n')

    await write(join(dir, 'node.cmd'), '@echo off\r\n"%TRYMYDEV_NODE%" %*\r\n')
    await write(join(dir, 'npm.cmd'), '@echo off\r\n"%TRYMYDEV_NODE%" "%TRYMYDEV_NPM_CLI%" %*\r\n')
    await write(join(dir, 'npx.cmd'), '@echo off\r\n"%TRYMYDEV_NODE%" "%TRYMYDEV_NPM_CLI%" exec -- %*\r\n')
  } else {
    await write(join(dir, 'node'), `#!/bin/sh\nexec "${nodeBin}" "$@"\n`)
    await write(join(dir, 'npm'), `#!/bin/sh\nexec "${nodeBin}" "${npmCli}" "$@"\n`)
    await write(join(dir, 'npx'), `#!/bin/sh\nexec "${nodeBin}" "${npmCli}" exec -- "$@"\n`)
  }
  return dir
}

/** Rewrites only when the content changed — the launcher's own path moves on update. */
async function write(path: string, content: string): Promise<void> {
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === content) return
  } catch {
    /* rewrite it */
  }
  await writeExecutable(path, content)
}
