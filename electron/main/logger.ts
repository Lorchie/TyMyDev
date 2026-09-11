import { mkdirSync, readdirSync, unlinkSync } from 'fs'
import { appendFile, open } from 'fs/promises'
import { join } from 'path'
import { logsDir } from './paths'

const TAIL_LINES = 200
const KEEP_LOGS = 20
/** How much of the end of the file is read back for an error report. */
const FILE_TAIL_BYTES = 64 * 1024
/** Colour and cursor codes: noise in a file or a pop-up. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * One log file per run of one branch. The tail is kept in memory so an error
 * pop-up can show what happened without the user opening anything, and it is
 * where a full session recording would plug in later.
 */
export class BranchLog {
  private readonly file: string
  private readonly tail: string[] = []
  private readonly pending: string[] = []
  private flushing = false
  private sink: ((line: string) => void) | null = null

  constructor(appId: string, key: string) {
    const dir = logsDir(appId, key)
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    this.prune(dir)
  }

  get path(): string {
    return this.file
  }

  onLine(sink: (line: string) => void): void {
    this.sink = sink
  }

  write(chunk: string): void {
    for (const line of stripAnsi(chunk).split(/\r?\n/)) {
      if (line.trim() !== '') this.line(line)
    }
  }

  line(text: string): void {
    const clean = stripAnsi(text)
    this.tail.push(clean)
    if (this.tail.length > TAIL_LINES) this.tail.shift()
    this.pending.push(`[${new Date().toISOString()}] ${clean}\n`)
    if (!this.flushing) void this.flush()
    this.sink?.(clean)
  }

  getTail(lines = 40): string {
    return this.tail.slice(-lines).join('\n')
  }

  /** End of the file itself — where a detached application writes directly. */
  async fileTail(lines = 40): Promise<string> {
    try {
      const handle = await open(this.file, 'r')
      try {
        const { size } = await handle.stat()
        const length = Math.min(size, FILE_TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, size - length)
        return stripAnsi(buffer.toString('utf-8'))
          .split(/\r?\n/)
          .filter((l) => l.trim() !== '')
          .slice(-lines)
          .join('\n')
      } finally {
        await handle.close()
      }
    } catch {
      return this.getTail(lines)
    }
  }

  /** Written in batches, off the thread that draws the UI; logging never breaks a job. */
  private async flush(): Promise<void> {
    this.flushing = true
    while (this.pending.length > 0) {
      const chunk = this.pending.splice(0).join('')
      await appendFile(this.file, chunk, 'utf-8').catch(() => undefined)
    }
    this.flushing = false
  }

  private prune(dir: string): void {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .sort()
      for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOGS))) {
        unlinkSync(join(dir, f))
      }
    } catch {
      /* nothing to prune */
    }
  }
}
