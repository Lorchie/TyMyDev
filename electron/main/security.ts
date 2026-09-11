import { session, shell, type Session, type WebContents } from 'electron'
import { appLog } from './applog'

/**
 * Only web addresses leave TryMyDev for the browser. `file:`, `ms-settings:` and
 * custom protocols start programs — a page reached from a tested application must
 * never be able to ask for that.
 */
export function openExternalSafely(url: string): void {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    /* not a URL */
  }
  if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
  else appLog(`[security] refused to open ${url.slice(0, 200)}`)
}

/**
 * Whether `url` belongs where a window was opened. A web page: the same origin — another
 * port is another application. A file: that very file. `file:` URLs share no origin, and
 * any local HTML file loaded in the TryMyDev window — one dropped on it, say — would get
 * its bridge to the main process: enough to approve and run a manifest.
 */
export function samePlace(url: string, home: string): boolean {
  try {
    const target = new URL(url)
    const base = new URL(home)
    // Decoded: Node and Chromium do not escape the same characters of a path.
    if (base.protocol === 'file:') {
      return target.protocol === 'file:' && decodeURIComponent(target.pathname) === decodeURIComponent(base.pathname)
    }
    return target.origin === base.origin
  } catch {
    return false
  }
}

/**
 * Keeps a window on the pages it was opened for. New windows, and navigation anywhere
 * else, go to the browser through the same filter instead of loading inside TryMyDev.
 */
export function confine(contents: WebContents, home: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event) => {
    if (samePlace(event.url, home)) return
    event.preventDefault()
    openExternalSafely(event.url)
  })
}

/** What a tested web page may have; camera, microphone, location and the rest are refused. */
const WEB_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** Electron grants every permission a page asks for, unless a session says otherwise. */
export function restrictPermissions(target: Session, allowed: ReadonlySet<string> = new Set()): void {
  target.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)))
  target.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))
}

const partitionOf = (key: string): string => `persist:branch-${key}`

/**
 * Cookies and storage of one branch, kept apart: cookies ignore ports, so every
 * application served on 127.0.0.1 would otherwise read the others' — and TryMyDev's.
 */
export function branchSession(key: string): string {
  const partition = partitionOf(key)
  restrictPermissions(session.fromPartition(partition), WEB_PERMISSIONS)
  return partition
}

/** Logins and storage of a deleted branch go with it. */
export function forgetBranchSession(key: string): void {
  void session
    .fromPartition(partitionOf(key))
    .clearStorageData()
    .catch(() => undefined)
}
