import type { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { createConnection } from 'net'
import { dirname, join } from 'path'
import type { OverlayOptions } from './attach'
import type { Journal, JournalSnapshot, Recording } from './journal'
import { redactText } from './redact'
import { prepareReport, reportArchive, reportFileName } from './report'

/**
 * What an agent reaches of a tested application: its windows through the Chrome DevTools
 * Protocol, the journal, and the bug report. It runs where the overlay does — in TryMyDev for
 * web applications, inside the application for Electron ones — so it uses nothing but
 * Electron and Node. The overlay's own view is never among the windows.
 */

export type AgentRequest =
  | { op: 'windows' }
  | { op: 'cdp'; window: number; method: string; params?: Record<string, unknown> }
  | { op: 'journal' }
  | { op: 'report'; window: number; description: string; screenshot: boolean }

export interface WindowInfo {
  id: number
  title: string
  focused: boolean
}

/**
 * The protocol commands an agent needs to act as a tester does: read the page, point, type,
 * look. Nothing that runs script in the page — a manifest's code is approved, not an agent's.
 */
export const CDP_METHODS = new Set([
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.getContentQuads',
  'DOM.focus',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics'
])

const DESCRIPTION_CHARS = 10_000

export class AgentTarget {
  private readonly windows = new Map<number, { window: BrowserWindow; recording: Recording }>()

  constructor(
    private readonly options: OverlayOptions,
    private readonly journal: Journal
  ) {}

  add(window: BrowserWindow, recording: Recording): void {
    const id = window.id
    this.windows.set(id, { window, recording })
    window.once('closed', () => this.windows.delete(id))
  }

  async handle(request: AgentRequest): Promise<unknown> {
    switch (request?.op) {
      case 'windows':
        return this.list()
      case 'cdp':
        return this.cdp(request.window, request.method, request.params)
      case 'journal':
        return this.journal.snapshot() satisfies JournalSnapshot
      case 'report':
        return this.report(request.window, request.description, request.screenshot)
      default:
        throw new Error(`Unknown request: ${String((request as { op?: unknown })?.op)}`)
    }
  }

  private list(): WindowInfo[] {
    return [...this.windows.values()]
      .filter(({ window }) => !window.isDestroyed())
      .map(({ window }) => ({ id: window.id, title: window.getTitle(), focused: window.isFocused() }))
  }

  private get(id: number): { window: BrowserWindow; recording: Recording } {
    const entry = this.windows.get(id)
    if (!entry || entry.window.isDestroyed()) throw new Error(`No window ${id}: it was closed. List the windows again.`)
    return entry
  }

  private async cdp(id: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!CDP_METHODS.has(method)) throw new Error(`Refused: ${method} is not a command an agent may send.`)
    const contents = this.get(id).window.webContents
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3')
      // Behind other windows a page stops rendering and its timers slow down: an agent
      // drives it while the developer works elsewhere.
      contents.setBackgroundThrottling(false)
    }
    return contents.debugger.sendCommand(method, params ?? {})
  }

  /** Written beside the branch's log, where the developer finds it — no dialog to answer. */
  private async report(id: number, description: string, screenshot: boolean): Promise<string> {
    const log = this.options.report?.log
    if (!log) throw new Error('This application has no log folder to write a report into.')
    const { window, recording } = this.get(id)
    const report = await prepareReport(window, this.options.label, this.options.report, this.journal, recording.take)
    const text = redactText(String(description ?? '').slice(0, DESCRIPTION_CHARS), this.journal.context)
    const path = join(dirname(log), 'reports', reportFileName(this.options.label, report.data.at))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, reportArchive(report.data, text, screenshot === false ? undefined : report.screenshot))
    return path
  }
}

/** Where the application reaches TryMyDev: a local pipe, and the secret that proves it was started by it. */
export interface AgentLinkInfo {
  pipe: string
  secret: string
}

/**
 * Inside a tested Electron application: answers TryMyDev's requests over the pipe it was
 * given — one JSON message per line, the secret first. A lost connection is only logged;
 * the application goes on as it was.
 */
export function connectAgent(link: AgentLinkInfo, target: AgentTarget, log: (message: string) => void): void {
  const socket = createConnection(link.pipe)
  socket.setEncoding('utf-8')
  socket.on('connect', () => socket.write(`${JSON.stringify({ hello: link.secret })}\n`))
  socket.on('error', (err) => log(`agent link: ${err.message}`))
  // The application quits when its windows close, whatever this socket does.
  socket.unref()

  let buffer = ''
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') void answer(line)
    }
  })

  const answer = async (line: string): Promise<void> => {
    let id: unknown
    try {
      const message = JSON.parse(line) as { id: unknown; request: AgentRequest }
      id = message.id
      const result = await target.handle(message.request)
      socket.write(`${JSON.stringify({ id, result })}\n`)
    } catch (err) {
      socket.write(`${JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) })}\n`)
    }
  }
}
