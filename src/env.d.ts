export interface BranchView {
  key: string
  appId: string
  owner: string
  repo: string
  ref: string
  pr?: number
  label: string
  builtSha?: string
  url?: string
  running: boolean
  busy: boolean
  addedAt: string
}

export interface AppView {
  id: string
  name: string
  repo?: string
  addedAt: string
  branches: BranchView[]
}

export interface JobEvent {
  key: string
  step: string
  message: string
  percent?: number
  since?: number
}

export interface JobError {
  key: string
  step: string
  message: string
  logTail: string
  logPath: string
  hint?: string
}

export interface Approval {
  appId: string
  appName: string
  repo: string
  upstream?: string
  foreign: boolean
  manifestHash: string
  source?: 'repository' | 'provided' | 'detected' | 'builtin'
  commands: string[]
  settings: string[]
  downloads: string[]
  warnings: string[]
}

export interface UsageEntry {
  label: string
  path: string
  bytes: number
  orphan: boolean
}

export interface Settings {
  githubToken: boolean
}

export interface Api {
  platform: string
  list: () => Promise<AppView[]>
  addApp: (input: string, manifest?: string) => Promise<AppView[]>
  removeApp: (appId: string) => Promise<AppView[]>
  addBranch: (appId: string, input: string) => Promise<AppView[]>
  removeBranch: (key: string) => Promise<AppView[]>
  start: (key: string) => Promise<void>
  cancel: (key: string) => Promise<void>
  refresh: () => Promise<AppView[]>
  shortcut: (key: string) => Promise<string>
  approve: (appId: string, hash: string, key: string) => Promise<void>
  usage: () => Promise<UsageEntry[]>
  prune: () => Promise<number>
  getSettings: () => Promise<Settings>
  setGithubToken: (token: string | null) => Promise<Settings & { limit?: number }>
  openLogs: (appId: string, key: string) => Promise<void>
  openAppLog: () => Promise<string>
  reportError: (message: string) => Promise<void>
  showItem: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  copy: (text: string) => Promise<void>
  onStep: (cb: (p: JobEvent) => void) => () => void
  onLog: (cb: (p: { key: string; line: string }) => void) => () => void
  onError: (cb: (p: JobError) => void) => () => void
  onApproval: (cb: (p: { key: string; approval: Approval }) => void) => () => void
  onUpdated: (cb: (p: { key: string }) => void) => () => void
  onRemote: (cb: (p: { key: string; remoteSha: string | null }) => void) => () => void
}

export interface OverlayAnchor {
  side: 'left' | 'right'
  y: number
}

/** The bridge of the overlay page, on top of a tested application. */
export interface OverlayApi {
  info: () => Promise<{ label: string; anchor: OverlayAnchor }>
  resize: (width: number, height: number, open: boolean) => void
  /** The view covers the window while the button moves; where it was, in the window. */
  drag: () => Promise<{ x: number; y: number }>
  drop: (x: number, y: number) => Promise<OverlayAnchor>
  report: {
    start: () => Promise<{ markdown: string; logs: string; screenshot?: string }>
    preview: (description: string) => Promise<string>
    /** The name of the saved file, or null when the tester cancelled. */
    save: (description: string, screenshot: boolean) => Promise<string | null>
    show: () => Promise<void>
    close: () => void
  }
}

declare global {
  interface Window {
    trymydev: Api
    overlay: OverlayApi
  }
}
