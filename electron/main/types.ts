/** Product identity. The IPC bridge key `window.trymydev` mirrors this name in preload and renderer. */
export const PRODUCT = {
  name: 'TryMyDev',
  /** File a project may commit at its root to describe how it runs. */
  manifestFile: 'trymydev.json'
} as const

// ─── Manifest ─────────────────────────────────────────────────────────────────

export type Platform = 'windows' | 'macos' | 'linux'
export type Gpu = 'nvidia' | 'amd' | 'none'

/** Restricts a step or a start to some machines. Each field takes one value or a list. */
export interface Condition {
  platform?: Platform | Platform[]
  gpu?: Gpu | Gpu[]
}

/**
 * A step is a command line split on spaces, honouring quotes. No shell: no pipes,
 * no `&&`, no variable expansion — what is written is what is executed, on every
 * platform, without a shell to inject into.
 */
export interface Step {
  run: string
  /** Directory relative to the checkout. Defaults to the checkout itself. */
  cwd?: string
  /** Runs the step only on machines this matches; everywhere when absent. */
  when?: Condition
}

export type StartSpec =
  /** An Electron app: launched on a compatible Electron with its own user-data dir. */
  | { mode: 'electron' }
  /**
   * A server: started, then its address is opened. `{port}` in `run` or `url` becomes
   * a free port, searched from `port`; without it, `port` is where the server is awaited.
   */
  | { mode: 'web'; run: string; port?: number; url?: string }
  /** Anything else: started and left running, no window of our own. */
  | { mode: 'command'; run: string }

/** One of several starts: the first whose condition matches the machine is used. */
export type ConditionalStart = StartSpec & { when?: Condition }

/** A directory shared by every branch of the app instead of being duplicated. */
export interface ShareSpec {
  /** Path inside the checkout that becomes a link to the app-wide copy. */
  path: string
  /** Optional environment variable pointing at the shared directory. */
  env?: string
}

/** A directory a branch must NOT share with its siblings, redirected per branch. */
export interface IsolateSpec {
  env: string
  /** Sub-directory of the branch data folder the variable points at. */
  dir: string
}

/**
 * A file or link the application finds in its data folder when it starts: settings that
 * point at the right folders, a marker saying a setup screen was already done for it.
 * Strings may use {data}, {shared}, {venv}, {documents} and {sha256:<checkout file>}.
 */
export interface SeedSpec {
  /** Path inside the branch data folder. */
  path: string
  /** JSON written there — once, keeping what the application changed, unless `always`. */
  json?: unknown
  /** Directory the path links to, placed again at every start. */
  link?: string
  always?: boolean
}

export interface Manifest {
  /** Display name of the application. */
  name: string
  /** Default repository, `owner/repo`. Branches may come from any fork of it. */
  repo?: string
  /** Runtimes the project needs; downloaded once and shared by every app. */
  runtime?: { node?: string; python?: string }
  install?: Step[]
  build?: Step[]
  start: StartSpec | ConditionalStart[]
  share?: ShareSpec[]
  isolate?: IsolateSpec[]
  seed?: SeedSpec[]
  env?: Record<string, string>
  /** Files whose hash decides when a cached environment must be rebuilt. */
  cacheKeys?: { node?: string[]; python?: string[] }
  /** Set by the loader, never written by hand. */
  source?: 'repository' | 'provided' | 'detected' | 'builtin'
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** A manifest the user approved, for the code of one repository. */
export interface Approved {
  hash: string
  /** `owner/repo`, lowercase: whose code the approval trusts with these commands. */
  source: string
}

export interface App {
  id: string
  name: string
  /** Upstream repository, `owner/repo`: its forks and pull requests belong here. */
  repo?: string
  /** Manifest handed over by the developer, if any. The repository wins over it. */
  manifest?: Manifest
  approvals?: Approved[]
  /** Approvals recorded by earlier versions: bare hashes, valid for the upstream only. */
  approvedHashes?: string[]
  addedAt: string
}

export interface Source {
  owner: string
  repo: string
  ref: string
  pr?: number
}

export interface Branch extends Source {
  key: string
  appId: string
  addedAt: string
}

export interface BranchState {
  sha?: string
  builtSha?: string
  /** Hash of the manifest used for the last successful build. */
  manifestHash?: string
  nodeKey?: string
  pythonKey?: string
  electronMajor?: string
  electronBinary?: string
  /** Address to open for a `web` start, remembered between runs. */
  url?: string
  lastCheck?: string
  lastLaunch?: string
  /** A detached application left running, found again after TryMyDev restarts. */
  running?: { pid: number; image: string; startedAt?: number }
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export type JobStep =
  | 'resolve'
  | 'download'
  | 'manifest'
  | 'runtime'
  | 'install'
  | 'build'
  | 'launch'
  | 'running'
  | 'done'

export interface JobEvent {
  key: string
  step: JobStep
  message: string
  percent?: number
  /** When the current step began, for the elapsed time shown on the card. */
  since?: number
}

export interface JobError {
  key: string
  step: JobStep
  message: string
  logTail: string
  logPath: string
  /** What the tester can do about it, for failures seen before. */
  hint?: string
}

/** Shown before a manifest runs for the first time, so nothing executes unseen. */
export interface Approval {
  appId: string
  appName: string
  /** `owner/repo` the code comes from. */
  repo: string
  /** `owner/repo` of the application, when known. */
  upstream?: string
  /** The code comes from another repository than the application's own. */
  foreign: boolean
  manifestHash: string
  source: Manifest['source']
  commands: string[]
  /** Links, per-branch redirections and environment variables the manifest sets up. */
  settings: string[]
  downloads: string[]
  /** What the sources will lack, such as submodules GitHub archives leave out. */
  warnings: string[]
}
