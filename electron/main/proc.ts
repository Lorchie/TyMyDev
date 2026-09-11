import { execFile, spawn, type ChildProcess } from 'child_process'
import crossSpawn from 'cross-spawn'
import { existsSync } from 'fs'
import { readlink } from 'fs/promises'
import { basename, delimiter, extname, join, sep } from 'path'
import { promisify } from 'util'
import { cacheDir, pythonsDir } from './paths'
import { npmCliPath } from './runtimes/shim'
import type { BranchLog } from './logger'
import type { NodeRuntime } from './runtimes/node'
import type { PythonRuntime } from './runtimes/python'

const execFileAsync = promisify(execFile)

/**
 * Everything a job needs to run commands, carried by the job itself. Module-level
 * state would break the moment two applications need different runtimes.
 */
export interface Toolchain {
  /** Directories prepended to PATH, in order. */
  pathDirs: string[]
  node?: NodeRuntime
  python?: PythonRuntime
  /** Interpreter of the branch's virtual environment, when it has one. */
  venvPython?: string
  uvBin?: string
  env?: Record<string, string>
  /** Proxy of the system, for tools that only read HTTPS_PROXY. */
  proxy?: string
}

export interface RunContext {
  toolchain: Toolchain
  cwd: string
  log: BranchLog
  signal?: AbortSignal
  extraEnv?: Record<string, string>
}

/** Splits a command line on spaces, honouring quotes. No shell, no expansion. */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ' ') {
      if (current !== '') parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') parts.push(current)
  if (quote) throw new Error(`Unbalanced quote in command: ${line}`)
  return parts
}

export function buildPath(toolchain: Toolchain): string {
  return [...toolchain.pathDirs, process.env.PATH ?? ''].filter(Boolean).join(delimiter)
}

/** Variables named like credentials. */
const CREDENTIAL =
  /(^|_)(TOKEN|AUTHTOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|DSN|COOKIE)(_|$)/i
/** A value carrying a user and a password, such as `postgres://user:secret@host/db`. */
const URL_WITH_PASSWORD = /\/\/[^/\s:@]+:[^/\s@]+@/
/** Proxies keep theirs: without it, nothing downloads behind a proxy that asks for one. */
const PROXY = /(^|_)PROXY$/i

/**
 * Settings a tester made for their own work, which change how Node, npm, Python, pip or uv
 * behave: with them, the same branch installs one way here and another way there —
 * NODE_ENV=production skips the build tools, PIP_USER installs outside the environment.
 * A manifest that needs one sets it in `env`.
 */
const MACHINE_SETTINGS = new Set(
  [
    'NODE_OPTIONS',
    'NODE_ENV',
    'NODE_PATH',
    'npm_config_ignore_scripts',
    'npm_config_omit',
    'npm_config_include',
    'npm_config_production',
    'npm_config_global',
    'npm_config_prefix',
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PYTHONUSERBASE',
    'PIP_USER',
    'PIP_REQUIRE_VIRTUALENV',
    'PIP_TARGET',
    'PIP_PREFIX',
    'UV_PYTHON',
    'UV_SYSTEM_PYTHON',
    'UV_NO_MANAGED_PYTHON',
    'UV_PYTHON_DOWNLOADS',
    // An environment the tester activated is theirs, not the application's.
    'VIRTUAL_ENV',
    'CONDA_PREFIX',
    'CONDA_DEFAULT_ENV',
    'PYENV_VERSION',
    // Inherited from our own process, it would turn a spawned Electron app into Node.
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_OVERRIDE_DIST_PATH',
    // TryMyDev's dev server: an electron-vite application would load our page instead of its own.
    'ELECTRON_RENDERER_URL',
    // Rebuilt below; Windows spells it both ways.
    'PATH'
  ].map((name) => name.toUpperCase())
)

/**
 * The tester's environment, minus what looks like a credential — a GitHub or cloud token
 * has no business reaching a branch built from someone else's code — and minus their own
 * tool settings. TRYMYDEV_PASS_ENV names, comma-separated, the ones an application does need.
 */
function inheritedEnv(): NodeJS.ProcessEnv {
  const passed = new Set(
    (process.env.TRYMYDEV_PASS_ENV ?? '')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean)
  )
  return Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => {
      const upper = name.toUpperCase()
      if (passed.has(upper)) return true
      if (MACHINE_SETTINGS.has(upper) || CREDENTIAL.test(name)) return false
      return PROXY.test(name) || !URL_WITH_PASSWORD.test(value ?? '')
    })
  )
}

const inherits = (name: string): boolean => Object.keys(process.env).some((key) => key.toUpperCase() === name)

/**
 * npm, pip, uv and Electron's downloader read HTTPS_PROXY, never the proxy configured in
 * the system or its PAC file. Given the one the system uses, unless the tester set their own.
 */
function proxyEnv(proxy: string | undefined): Record<string, string> {
  if (!proxy || ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].some(inherits)) return {}
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    // An application talking to its own server on this computer must not go through it.
    ...(inherits('NO_PROXY') ? {} : { NO_PROXY: 'localhost,127.0.0.1,::1' }),
    ELECTRON_GET_USE_PROXY: '1',
    GLOBAL_AGENT_HTTPS_PROXY: proxy
  }
}

export function buildEnv(ctx: RunContext): NodeJS.ProcessEnv {
  const { node } = ctx.toolchain
  return {
    ...inheritedEnv(),
    ...proxyEnv(ctx.toolchain.proxy),
    // Downloads stay in the store: measured and cleaned up by Storage, and on the
    // volume of the environments uv hardlinks them into.
    UV_CACHE_DIR: cacheDir('uv'),
    PIP_CACHE_DIR: cacheDir('pip'),
    npm_config_cache: cacheDir('npm'),
    electron_config_cache: cacheDir('electron'),
    UV_PYTHON_INSTALL_DIR: pythonsDir(),
    UV_PYTHON_PREFERENCE: 'only-managed',
    // Windows in a non-UTF-8 locale: without it, a script printing an emoji into a log crashes.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    // Output reaches the log — and the address of a server reaches TryMyDev — as it is printed.
    PYTHONUNBUFFERED: '1',
    // Packages the tester installed with `pip install --user` stay out of the environments.
    PYTHONNOUSERSITE: '1',
    // Certificates of the system on top of Node's own: a company's inspecting proxy is trusted.
    NODE_USE_SYSTEM_CA: '1',
    ...ctx.toolchain.env,
    ...ctx.extraEnv,
    // Read by the Windows shims: a batch file holding a path with accents breaks, a variable does not.
    ...(node ? { TRYMYDEV_NODE: node.bin, TRYMYDEV_NPM_CLI: npmCliPath() } : {}),
    PATH: buildPath(ctx.toolchain),
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false'
  }
}

/**
 * Maps the tool names a manifest may use onto the runtimes we provide, so
 * `npm install` or `pip install -r requirements.txt` means the same thing on
 * every machine — and never depends on what the tester happens to have.
 */
function resolveCommand(
  command: string,
  args: string[],
  toolchain: Toolchain
): { file: string; args: string[] } {
  const { node, python, venvPython, uvBin } = toolchain
  const name = basename(command).toLowerCase().replace(/\.(exe|cmd)$/, '')

  if (name === 'node' && node) return { file: node.bin, args }
  if (name === 'npm' && node) return { file: node.bin, args: [npmCliPath(), ...args] }
  if (name === 'npx' && node) return { file: node.bin, args: [npmCliPath(), 'exec', '--', ...args] }
  if (name === 'uv' && uvBin) return { file: uvBin, args }

  if (name === 'python' || name === 'python3') {
    const bin = venvPython ?? python?.bin
    if (bin) return { file: bin, args }
  }
  if (name === 'pip' || name === 'pip3') {
    // uv resolves and installs far faster, and shares wheels between environments.
    if (uvBin && venvPython) return { file: uvBin, args: ['pip', ...args, '--python', venvPython] }
    const bin = venvPython ?? python?.bin
    if (bin) return { file: bin, args: ['-m', 'pip', ...args] }
  }

  return { file: resolveOnPath(command, toolchain), args }
}

function resolveOnPath(command: string, toolchain: Toolchain): string {
  if (command.includes(sep) || command.includes('/')) return command
  // Without a shell nothing looks up `pnpm.cmd` for us: the system PATH is searched too.
  const dirs = [...toolchain.pathDirs, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  const extensions =
    process.platform === 'win32' && extname(command) === '' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

/** Runs a command to completion, streaming its output into the branch log. */
export function run(line: string, ctx: RunContext): Promise<void> {
  const [command, ...rest] = splitCommand(line)
  if (!command) return Promise.resolve()
  const { file, args } = resolveCommand(command, rest, ctx.toolchain)

  return new Promise((resolve, reject) => {
    ctx.log.line(`$ ${line}`)
    const child = start(file, args, ctx)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Command failed (exit code ${code}): ${line}\n${ctx.log.getTail(15)}`))
    })
  })
}

/**
 * Starts a command and hands the process back, for servers and applications. Given
 * `output`, a file descriptor, it is detached and writes there instead of a pipe.
 */
export function startProcess(line: string, ctx: RunContext, output?: number): ChildProcess {
  const [command, ...rest] = splitCommand(line)
  const { file, args } = resolveCommand(command ?? '', rest, ctx.toolchain)
  ctx.log.line(`$ ${line}`)
  return start(file, args, ctx, output)
}

function start(file: string, args: string[], ctx: RunContext, output?: number, logged = true): ChildProcess {
  // cross-spawn runs .cmd and .bat files through cmd.exe with every argument escaped;
  // handing them to cmd.exe as they are would let an argument such as "a&whoami" run whoami.
  const child = crossSpawn(file, args, {
    cwd: ctx.cwd,
    env: buildEnv(ctx),
    windowsHide: true,
    // POSIX: a process group of its own, so killTree reaches its children. Windows:
    // only what must outlive TryMyDev leaves the job object that ends with it.
    detached: process.platform !== 'win32' || output !== undefined,
    stdio: output === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', output, output]
  })

  if (logged) {
    child.stdout?.on('data', (d: Buffer) => ctx.log.write(d.toString()))
    child.stderr?.on('data', (d: Buffer) => ctx.log.write(d.toString()))
  }
  const { signal } = ctx
  if (signal) {
    const abort = (): void => killTree(child)
    signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
  }
  return child
}

/**
 * Stops a process and everything it started. Killing only the direct child leaves
 * the server behind `npm run dev` running, and holding its port. Takes a PID for an
 * application found again after a restart.
 */
export function killTree(target: ChildProcess | number): void {
  const pid = typeof target === 'number' ? target : target.pid
  if (pid === undefined) return
  if (typeof target !== 'number' && (target.exitCode !== null || target.signalCode !== null)) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => signal(pid)
    )
    return
  }
  if (!signal(-pid)) signal(pid)
}

function signal(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Executable name of a running process — what tells an application from a reused PID. */
export async function processImage(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
      const { stdout } = await execFileAsync(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true
      })
      const row = stdout.match(/^"([^"]+)","(\d+)"/m)
      return row && Number(row[2]) === pid ? row[1].toLowerCase() : undefined
    }
    if (process.platform === 'linux') {
      // `ps -o comm` gives the name of the main thread, which Node renames "MainThread": the
      // executable itself is the link /proc keeps.
      const exe = await readlink(`/proc/${Math.trunc(pid)}/exe`)
      return basename(exe.replace(/ \(deleted\)$/, '')).toLowerCase() || undefined
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='])
    return basename(stdout.trim()).toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/**
 * When a process started, in milliseconds. A PID and an executable name are not enough
 * to recognise an application after a restart: `node.exe` or `python.exe` holding the
 * same PID may well be one of the tester's own.
 */
export async function processStartTime(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const { stdout } = await execFileAsync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToUniversalTime().ToString('o')`],
        { windowsHide: true, timeout: 20_000 }
      )
      const time = Date.parse(stdout.trim())
      return Number.isNaN(time) ? undefined : time
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(Math.trunc(pid)), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' }
    })
    const time = Date.parse(stdout.trim())
    return Number.isNaN(time) ? undefined : time
  } catch {
    return undefined
  }
}

/**
 * Captures stdout instead of only logging it — used to ask a project a question.
 * `quiet` keeps the answer out of the branch log, for questions whose failure is expected.
 */
export function capture(line: string, ctx: RunContext, options: { quiet?: boolean } = {}): Promise<string> {
  const [command, ...rest] = splitCommand(line)
  const { file, args } = resolveCommand(command ?? '', rest, ctx.toolchain)

  return new Promise((resolve, reject) => {
    const child = start(file, args, ctx, undefined, !options.quiet)
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`Command failed (exit code ${code}): ${line}`))
    )
  })
}
