import type { BrowserWindow } from 'electron'
import { uptime } from 'os'
import { appLog } from './applog'
import { hintFor, tidyTail } from './hints'
import { BranchLog } from './logger'
import { processImage, processStartTime } from './proc'
import { ApprovalRequired, checkRemote, patchState, provision, readState } from './provision'
import * as registry from './registry'
import { adopt, isRunning, launch, stop } from './runner'
import type { Branch, BranchState, JobError, JobEvent, JobStep } from './types'

const jobs = new Map<string, AbortController>()
/** Jobs still preparing — installing from the download caches — rather than running. */
const preparing = new Set<string>()

export function busy(key: string): boolean {
  return jobs.has(key)
}

export function installing(): boolean {
  return preparing.size > 0
}

export function cancel(key: string): void {
  jobs.get(key)?.abort(new Error('Cancelled by the user'))
  stop(key)
}

/**
 * Update if needed, then run. Nothing here throws at the caller: a failure
 * reaches the tester as a pop-up carrying the tail of the log, and an
 * unapproved manifest reaches them as the list of commands it wants to run.
 */
export async function startBranch(win: BrowserWindow, key: string): Promise<void> {
  if (jobs.has(key) || isRunning(key)) return

  const branch = registry.getBranch(key)
  const app = registry.getApp(branch.appId)
  const controller = new AbortController()
  jobs.set(key, controller)

  const log = new BranchLog(app.id, key)
  log.line(`=== ${app.name} · ${registry.label(branch)} ===`)
  log.onLine((line) => send(win, 'job:log', { key, line }))

  let step: JobStep = 'resolve'
  let since = Date.now()
  const emit = (s: JobStep, message: string, percent?: number): void => {
    if (s !== step) since = Date.now()
    step = s
    send<JobEvent>(win, 'job:step', { key, step: s, message, percent, since })
  }

  try {
    preparing.add(key)
    const { manifest, state, toolchain } = await provision(app, branch, log, emit, controller.signal).finally(
      () => preparing.delete(key)
    )

    emit('launch', `Starting ${manifest.name}…`)
    const { url, detached } = await launch(app, branch, manifest, state, toolchain, log, controller.signal, (code) => {
      jobs.delete(key)
      patchState(app.id, key, { running: undefined })
      send(win, 'branch:updated', { key })
      if (code === 0 || code === null) {
        emit('done', `${manifest.name} closed`)
        return
      }
      // The application writes into the log file itself, so the tail is read there.
      void log.fileTail(30).then((logTail) =>
        fail(win, {
          key,
          step: 'running',
          message: `${manifest.name} exited with code ${code}.`,
          logTail,
          logPath: log.path
        })
      )
    })

    patchState(app.id, key, { url, lastLaunch: new Date().toISOString(), running: detached })
    emit('running', url ? `Running on ${url}` : `${manifest.name} is open`)
    send(win, 'branch:updated', { key })
  } catch (err) {
    jobs.delete(key)

    if (err instanceof ApprovalRequired) {
      log.line('[approval] waiting for the user to review the manifest')
      emit('done', 'Waiting for your approval')
      send(win, 'job:approval', { key, approval: err.approval })
      send(win, 'branch:updated', { key })
      return
    }

    const message = err instanceof Error ? err.message : String(err)
    log.line(`[error] ${message}`)
    // A cancellation kills the running command, which then reports a failure of
    // its own — the tester asked for it, so it is not worth a pop-up.
    if (controller.signal.aborted) emit('done', 'Cancelled')
    else fail(win, { key, step, message, logTail: log.getTail(30), logPath: log.path })
    send(win, 'branch:updated', { key })
  }
}

/** How far the start time the system reports may be from the one recorded at launch. */
const START_TOLERANCE_MS = 60_000

/**
 * Whether a recorded application is still the process holding its PID. After a reboot, or
 * once it has exited, the same PID can belong to one of the tester's own programs — often
 * a node.exe or python.exe — which Stop would otherwise kill with its whole tree.
 */
async function stillOurs(running: NonNullable<BranchState['running']>, lastLaunch?: string): Promise<boolean> {
  const image = await processImage(running.pid)
  // ps may shorten the name; tasklist gives it whole.
  if (image === undefined || !running.image.startsWith(image)) return false

  const startedAt = running.startedAt ?? (lastLaunch ? Date.parse(lastLaunch) : NaN)
  if (Number.isNaN(startedAt)) return true
  if (startedAt < Date.now() - uptime() * 1000) return false
  const actual = await processStartTime(running.pid)
  return actual === undefined || Math.abs(actual - startedAt) <= START_TOLERANCE_MS
}

/**
 * After a restart, applications left running show as running again — and can be
 * stopped. A PID now held by another program is told apart by its executable and the
 * time it started.
 */
export async function reattach(getWindow: () => BrowserWindow | null): Promise<void> {
  for (const branch of registry.branches()) {
    const { running, lastLaunch } = readState(branch.appId, branch.key)
    if (!running || isRunning(branch.key)) continue

    if (!(await stillOurs(running, lastLaunch))) {
      patchState(branch.appId, branch.key, { running: undefined })
      continue
    }
    adopt(branch.key, running.pid, () => {
      patchState(branch.appId, branch.key, { running: undefined })
      const win = getWindow()
      if (win) send(win, 'branch:updated', { key: branch.key })
    })
  }
}

/** Conditional requests, so re-checking an unchanged branch costs no rate limit. */
export async function refresh(win: BrowserWindow, list: Branch[]): Promise<void> {
  for (const branch of list) {
    const remoteSha = await checkRemote(branch)
    send(win, 'branch:remote', {
      key: branch.key,
      remoteSha,
      builtSha: readState(branch.appId, branch.key).builtSha ?? null
    })
  }
}

function fail(win: BrowserWindow, error: JobError): void {
  appLog(`[job] ${error.key} failed at ${error.step}: ${error.message.split('\n')[0]}`)
  send<JobError>(win, 'job:error', {
    ...error,
    logTail: tidyTail(error.logTail),
    hint: hintFor(`${error.message}\n${error.logTail}`)
  })
}

function send<T>(win: BrowserWindow, channel: string, payload: T): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}
