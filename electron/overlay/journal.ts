import type { WebContents } from 'electron'
import { homedir, hostname } from 'os'
import { actionText, RECORDER_SOURCE, RECORDER_WORLD, type RawAction } from './recorder'
import { redactText, redactUrl, type RedactContext } from './redact'

/**
 * The last minutes of a tested application, for a bug report: what the tester did, where
 * the page went, and what went wrong. Everything is masked as it comes in.
 */

export type EntryKind = 'action' | 'navigation' | 'info' | 'warning' | 'error' | 'crash'

export interface Entry {
  t: number
  kind: EntryKind
  text: string
  /** A stack trace or the whole message, when there is more than one line to say. */
  detail?: string
  /** The same entry, repeated in a row. */
  count?: number
}

export interface JournalSnapshot {
  /** Actions, navigation and failures of the last minutes, oldest first. */
  timeline: Entry[]
  /** Errors and crashes, however old, newest first. */
  errors: Entry[]
  warnings: Entry[]
}

const ACTIONS_KEPT = 200
const PROBLEMS_KEPT = 100
export const TIMELINE_MS = 10 * 60_000
const DETAIL_CHARS = 4000
/** A page decides what its elements are called: an id of a megabyte stays out of the report. */
const TEXT_CHARS = 500

const isProblem = (kind: EntryKind): boolean => kind === 'warning' || kind === 'error' || kind === 'crash'

export class Journal {
  private events: Entry[] = []
  private problems: Entry[] = []

  constructor(
    readonly context: RedactContext = { home: homedir(), hostname: hostname() },
    private readonly now: () => number = Date.now
  ) {}

  add(kind: EntryKind, text: string, detail?: string, t = this.now()): void {
    // Masked before it is cut: a token cut in half would no longer be recognised.
    const entry: Entry = { t, kind, text: redactText(text.slice(0, TEXT_CHARS * 4), this.context).slice(0, TEXT_CHARS) }
    if (detail) entry.detail = redactText(detail.slice(0, DETAIL_CHARS * 2), this.context).slice(0, DETAIL_CHARS)
    const list = isProblem(kind) ? this.problems : this.events
    const last = list[list.length - 1]
    if (last && last.kind === entry.kind && last.text === entry.text && last.detail === entry.detail) {
      last.count = (last.count ?? 1) + 1
      last.t = Math.max(last.t, entry.t)
      return
    }
    list.push(entry)
    const kept = isProblem(kind) ? PROBLEMS_KEPT : ACTIONS_KEPT
    if (list.length > kept) list.splice(0, list.length - kept)
  }

  navigation(url: string): void {
    this.add('navigation', `Went to ${redactUrl(url, this.context)}`)
  }

  snapshot(): JournalSnapshot {
    const since = this.now() - TIMELINE_MS
    const copy = (entries: Entry[]): Entry[] => entries.map((entry) => ({ ...entry }))
    const timeline = copy([...this.events, ...this.problems.filter((e) => e.kind !== 'warning')])
      .filter((entry) => entry.t >= since)
      .sort((a, b) => a.t - b.t)
    // Reversed first: entries of the same millisecond keep the later one first.
    const newestFirst = (kind: (k: EntryKind) => boolean): Entry[] =>
      copy(this.problems.filter((e) => kind(e.kind)).reverse()).sort((a, b) => b.t - a.t)
    return {
      timeline,
      errors: newestFirst((k) => k === 'error' || k === 'crash'),
      warnings: newestFirst((k) => k === 'warning')
    }
  }
}

const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** A console level in Electron's words, before (0-3) and after (strings) Electron 35. */
function consoleKind(level: unknown): EntryKind | undefined {
  if (level === 'error' || level === 3) return 'error'
  if (level === 'warning' || level === 2) return 'warning'
  return undefined
}

function validAction(value: unknown): value is RawAction {
  const action = value as RawAction
  return !!action && typeof action.t === 'number' && typeof action.kind === 'string'
}

/**
 * Records a page: its console errors, navigation and crashes from here, the tester's
 * actions from the recorder injected into it. `take` collects the recorder's actions at
 * once — before a report, so the last click is in it.
 */
export interface Recording {
  take: () => Promise<void>
}

export function watchContents(contents: WebContents, journal: Journal): Recording {
  // Electron changed these events' arguments over its versions; the application brings its own.
  const on = (event: string, listener: (...args: any[]) => void): void => {
    ;(contents as unknown as NodeJS.EventEmitter).on(event, listener)
  }

  // Rest arguments: Electron warns about listeners declaring the old positional ones.
  on('console-message', (...args: any[]) => {
    const [event, level, message, line, source] = args
    const kind = consoleKind(event?.level ?? level)
    if (!kind) return
    // `%c` styles a console line in DevTools; in a report it is noise.
    const text = String(event?.message ?? message ?? '').replace(/%c/g, '')
    const where = event?.sourceId ?? source
    const at = where ? `\n    at ${where}:${event?.lineNumber ?? line}` : ''
    journal.add(kind, `Console ${kind}: ${firstLine(text)}`, `${text}${at}`)
  })
  on('did-navigate', (_event: unknown, url: string) => journal.navigation(url))
  on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame) journal.navigation(url)
  })
  on('did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
    // -3 is a navigation replaced by another one.
    if (isMainFrame && code !== -3) journal.add('error', `The page failed to load ${redactUrl(url, journal.context)}: ${description} (${code})`)
  })
  on('preload-error', (_event: unknown, path: string, error: Error) => {
    journal.add('error', `Preload script failed: ${path}: ${firstLine(error?.message ?? '')}`, error?.stack)
  })
  on('render-process-gone', (_event: unknown, details: { reason: string; exitCode: number }) => {
    if (details.reason !== 'clean-exit') journal.add('crash', `The page's process is gone: ${details.reason} (exit code ${details.exitCode})`)
  })
  on('unresponsive', () => journal.add('error', 'The page stopped responding'))
  on('responsive', () => journal.add('info', 'The page responds again'))

  const run = <T>(code: string): Promise<T> =>
    contents.executeJavaScriptInIsolatedWorld(RECORDER_WORLD, [{ code }]) as Promise<T>

  const inject = (): void => {
    if (!contents.isDestroyed()) run(RECORDER_SOURCE).catch(() => undefined)
  }

  const take = async (): Promise<void> => {
    if (contents.isDestroyed()) return
    try {
      const actions = await run<unknown>('typeof __tmdTake === "function" ? __tmdTake() : null')
      // A document the recorder missed — loaded before the window was watched — gets it now.
      if (actions === null) return inject()
      for (const action of Array.isArray(actions) ? actions : []) {
        if (validAction(action)) journal.add('action', actionText(action), undefined, action.t)
      }
    } catch {
      /* the page is between two documents */
    }
  }

  on('dom-ready', inject)
  // A document about to be replaced takes its last actions with it.
  on('did-start-navigation', (...args: any[]) => {
    const [details, , isSameDocument, isMainFrame] = args
    const same = details?.isSameDocument ?? isSameDocument
    const main = details?.isMainFrame ?? isMainFrame
    if (main && !same) void take()
  })
  // A window is often shown while its page still loads, after dom-ready: injected at once too.
  inject()

  const timer = setInterval(() => void take(), 1000)
  timer.unref?.()
  on('destroyed', () => clearInterval(timer))

  return { take }
}
