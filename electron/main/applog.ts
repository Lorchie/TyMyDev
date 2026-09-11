import { appendFile, mkdir, rename, stat } from 'fs/promises'
import { dirname } from 'path'
import { appLogPath } from './paths'

const MAX_BYTES = 5 * 1024 * 1024

let chain: Promise<unknown> | undefined

/** Keeps one previous file, so the log never grows without bound. */
async function prepare(): Promise<void> {
  const path = appLogPath()
  await mkdir(dirname(path), { recursive: true })
  const size = (await stat(path).catch(() => undefined))?.size ?? 0
  if (size > MAX_BYTES) await rename(path, path.replace(/\.log$/, '.old.log')).catch(() => undefined)
}

/**
 * TryMyDev's own log: what fails outside any branch job — a call from the window, an
 * uncaught error. Lines are appended in order, and never break what logs them.
 */
export function appLog(text: string): void {
  const line = `[${new Date().toISOString()}] ${text}\n`
  chain = (chain ?? prepare())
    .then(() => appendFile(appLogPath(), line, 'utf-8'))
    .catch(() => undefined)
}

export function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}
