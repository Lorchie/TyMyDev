import { app, screen, type BrowserWindow } from 'electron'
import { open } from 'fs/promises'
import { arch, cpus, release, totalmem, version } from 'os'
import type { Entry, JournalSnapshot } from './journal'
import { redactText, type RedactContext } from './redact'
import { zip, type ZipEntry } from './zip'

/** What TryMyDev knows about the branch, handed to the overlay. */
export interface ReportSource {
  /** `owner/repo@ref`, or its pull request. */
  source: string
  commit?: string
  /** The branch's log file: a backend's errors are only there. */
  log?: string
}

export interface ReportData {
  label: string
  source?: ReportSource
  at: number
  environment: string[]
  journal: JournalSnapshot
  /** The end of the branch's log, masked. */
  log: string[]
}

const LOG_LINES_IN_REPORT = 40
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

const pad = (n: number): string => String(n).padStart(2, '0')

export function clock(t: number): string {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function stamp(t: number): string {
  const d = new Date(t)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(t)} (${zone})`
}

/** A code block no line of `text` can close early. */
export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}text\n${text}\n${ticks}`
}

/** One line of Markdown: no line breaks, and no `<` that GitHub would take for HTML. */
const inline = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').replace(/</g, '\\<')

const repeated = (entry: Entry): string => (entry.count && entry.count > 1 ? ` (×${entry.count})` : '')

const LABELS: Partial<Record<Entry['kind'], string>> = { error: '**Error** ', crash: '**Crash** ' }

export function reportMarkdown(data: ReportData, description: string): string {
  const { journal } = data
  const out: string[] = [`# Bug report: ${inline(data.label)}`, '', '## What happened', '']
  out.push(description.trim() || '_No description given._', '')

  out.push('## Error', '')
  const [latest, ...earlier] = journal.errors
  if (!latest) {
    out.push('No error was recorded in the application. A failure of its backend or server would be in the log below.', '')
  } else {
    out.push(`**${clock(latest.t)}** ${inline(latest.text)}${repeated(latest)}`, '')
    if (latest.detail) out.push(fence(latest.detail), '')
    if (earlier.length > 0) {
      out.push('Earlier errors:', '')
      for (const entry of earlier.slice(0, 9)) out.push(`- ${clock(entry.t)} ${inline(entry.text)}${repeated(entry)}`)
      out.push('')
    }
  }

  if (journal.warnings.length > 0) {
    out.push(`## Warnings (${journal.warnings.length})`, '')
    for (const entry of journal.warnings.slice(0, 10)) out.push(`- ${clock(entry.t)} ${inline(entry.text)}${repeated(entry)}`)
    out.push('')
  }

  out.push('## Steps (last 10 minutes)', '')
  if (journal.timeline.length === 0) out.push('_Nothing was recorded in the last 10 minutes._')
  for (const entry of journal.timeline) {
    out.push(`- ${clock(entry.t)} ${LABELS[entry.kind] ?? ''}${inline(entry.text)}${repeated(entry)}`)
  }
  out.push('')

  out.push('## Environment', '', `- Application: ${inline(data.label)}`)
  if (data.source) {
    const commit = data.source.commit ? ` · commit ${data.source.commit.slice(0, 12)}` : ''
    out.push(`- Source: ${inline(data.source.source)}${commit}`)
  }
  out.push(`- Reported: ${stamp(data.at)}`)
  for (const line of data.environment) out.push(`- ${inline(line)}`)
  out.push('')

  if (data.log.length > 0) {
    const shown = data.log.slice(-LOG_LINES_IN_REPORT)
    const more = data.log.length > shown.length ? ` — the last ${data.log.length} are in logs.txt` : ''
    out.push('## Log', '', `Last ${shown.length} lines${more}.`, '', fence(shown.join('\n')), '')
  }

  out.push(
    '---',
    '',
    '_Made with TryMyDev. Typed text is never recorded; tokens, e-mail addresses, user folders, computer names and web address parameters are masked. Masking is best-effort: read the report before sending it._',
    ''
  )
  return out.join('\n')
}

export function reportArchive(data: ReportData, description: string, screenshot?: Buffer): Buffer {
  const entries: ZipEntry[] = [{ name: 'report.md', data: Buffer.from(reportMarkdown(data, description), 'utf-8') }]
  if (screenshot) entries.push({ name: 'screenshot.png', data: screenshot })
  if (data.log.length > 0) entries.push({ name: 'logs.txt', data: Buffer.from(`${data.log.join('\n')}\n`, 'utf-8') })
  return zip(entries, new Date(data.at))
}

export function reportFileName(label: string, at: number): string {
  const d = new Date(at)
  const slug = label
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  const when = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `bug-report-${slug || 'app'}-${when}.zip`
}

/**
 * The end of a log, masked as a whole — a private key spans several lines — and without
 * terminal colours. A partial first line is dropped.
 */
export async function readLogTail(path: string, context: RedactContext, maxLines = 400, maxBytes = 256_000): Promise<string[]> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let lines = buffer.toString('utf-8').replace(ANSI, '').split(/\r?\n/)
    if (length < size) lines = lines.slice(1)
    const kept = lines.filter((line) => line.trim() !== '').slice(-maxLines)
    return redactText(kept.join('\n'), context).split('\n')
  } finally {
    await handle.close()
  }
}

const VENDORS: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple', 0x5143: 'Qualcomm' }

interface GpuDevice {
  vendorId?: number
  deviceId?: number
  deviceString?: string
  driverVersion?: string
  active?: boolean
}

/** The machine, as a developer needs it to reproduce: no names, no serial numbers. */
export async function environment(window: BrowserWindow): Promise<string[]> {
  const lines = [`System: ${version()} ${release()} (${arch()})`]
  const locale = (app as { getSystemLocale?: () => string }).getSystemLocale?.() ?? app.getLocale()
  if (locale) lines.push(`Language: ${locale}`)
  const cpu = cpus()
  if (cpu.length > 0) lines.push(`CPU: ${cpu[0].model.trim()} · ${cpu.length} threads`)
  lines.push(`Memory: ${Math.round(totalmem() / 1024 ** 3)} GB`)
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: GpuDevice[] }
    const gpus = (info.gpuDevice ?? []).map((gpu) => {
      const name = gpu.deviceString || `${VENDORS[gpu.vendorId ?? 0] ?? 'GPU'} ${(gpu.deviceId ?? 0).toString(16)}`
      return `${name}${gpu.driverVersion ? ` (driver ${gpu.driverVersion})` : ''}`
    })
    if (gpus.length > 0) lines.push(`GPU: ${[...new Set(gpus)].join(', ')}`)
  } catch {
    /* no GPU information on this platform */
  }
  lines.push(`Runtime: Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`)
  if (!window.isDestroyed()) {
    const [width, height] = window.getContentSize()
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor
    lines.push(`Window: ${width}×${height} at ${Math.round(scale * 100)}%`)
  }
  return lines
}
