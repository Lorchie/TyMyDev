import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AddAppDialog,
  ApprovalDialog,
  clean,
  ConfirmDialog,
  ErrorDialog,
  SettingsDialog,
  StorageDialog,
  type Confirmation
} from './dialogs'
import type { AppView, Approval, BranchView, FolderView, JobError, JobEvent } from './env'
import logo from '../resources/icon.svg'
import { ShortcutButton } from './ShortcutButton'

interface StepProgress {
  message: string
  percent?: number
  line?: string
  since?: number
}
type Progress = Record<string, StepProgress>
type Ask = (confirmation: Confirmation) => void

export default function App(): JSX.Element {
  const [apps, setApps] = useState<AppView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress>({})
  const [remote, setRemote] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<JobError | null>(null)
  const [approval, setApproval] = useState<{ key: string; approval: Approval } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [storage, setStorage] = useState(false)
  const [settings, setSettings] = useState(false)

  const reload = useCallback(async () => {
    const list = await window.trymydev.list()
    setApps(list)
    setSelected((current) => current ?? list[0]?.id ?? null)
  }, [])

  useEffect(() => {
    void reload()
    void window.trymydev.refresh().then(setApps)

    const offs = [
      window.trymydev.onStep((e: JobEvent) =>
        setProgress((p) => ({ ...p, [e.key]: { message: e.message, percent: e.percent, since: e.since } }))
      ),
      window.trymydev.onLog(({ key, line }) =>
        setProgress((p) => ({ ...p, [key]: { ...(p[key] ?? { message: '' }), line } }))
      ),
      window.trymydev.onError(setError),
      window.trymydev.onApproval(setApproval),
      window.trymydev.onUpdated(() => void reload()),
      window.trymydev.onRemote((e) => setRemote((r) => ({ ...r, [e.key]: e.remoteSha })))
    ]
    return () => offs.forEach((off) => off())
  }, [reload])

  // A failure nothing caught — a removal, an approval — still reaches the tester, and the log.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent): void => {
      const message = clean(event.reason)
      setNotice(message)
      window.trymydev.reportError(message).catch(() => undefined)
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  const current = apps.find((a) => a.id === selected) ?? null

  return (
    <div className={`app platform-${window.trymydev.platform}`}>
      <div className="titlebar">
        <img src={logo} alt="" width={24} height={24} />
        TryMyDev
      </div>
      <aside>
        <div className="apps">
          {apps.map((a) => (
            <button
              key={a.id}
              className={a.id === selected ? 'app-item selected' : 'app-item'}
              onClick={() => setSelected(a.id)}
            >
              <span className="app-label">
                <span className="app-name">{a.name}</span>
                {a.repo && <span className="app-repo">{a.repo}</span>}
              </span>
              <span className="app-count">{a.branches.length}</span>
            </button>
          ))}
          {apps.length === 0 && <p className="empty">No application yet.</p>}
        </div>
        <div className="aside-actions">
          <button className="primary" onClick={() => setAdding(true)}>
            Add an application
          </button>
          <button className="ghost" onClick={() => setStorage(true)}>
            Storage
          </button>
          <button className="ghost" onClick={() => setSettings(true)}>
            Settings
          </button>
        </div>
      </aside>

      <main>
        {current ? (
          <AppPanel
            app={current}
            progress={progress}
            remote={remote}
            onReload={reload}
            ask={setConfirmation}
          />
        ) : (
          <div className="placeholder">
            <h1>Test any branch of any project</h1>
            <p>
              Paste the address of a branch, a fork or a pull request. TryMyDev fetches the
              sources, builds them and starts the application — nothing else to install.
            </p>
            <button className="primary" onClick={() => setAdding(true)}>
              Add an application
            </button>
          </div>
        )}
      </main>

      {adding && (
        <AddAppDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            void reload()
            void window.trymydev.refresh().then(setApps)
          }}
        />
      )}
      {storage && <StorageDialog onClose={() => setStorage(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {error && <ErrorDialog error={error} onClose={() => setError(null)} />}
      {approval && (
        <ApprovalDialog
          approval={approval.approval}
          branchKey={approval.key}
          onClose={() => setApproval(null)}
          onApproved={() => setApproval(null)}
        />
      )}
      {confirmation && (
        <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      )}
      {notice && (
        <div className="toast" role="alert">
          <span>{notice}</span>
          <button className="ghost" onClick={() => void window.trymydev.openAppLog()}>
            Log
          </button>
          <button className="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

function AppPanel({
  app,
  progress,
  remote,
  onReload,
  ask
}: {
  app: AppView
  progress: Progress
  remote: Record<string, string | null>
  onReload: () => Promise<void>
  ask: Ask
}): JSX.Element {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const addBranch = async (): Promise<void> => {
    if (input.trim() === '') return
    setBusy(true)
    setAddError(null)
    try {
      await window.trymydev.addBranch(app.id, input)
      setInput('')
      await onReload()
    } catch (err) {
      setAddError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>{app.name}</h1>
          <p className="sub">
            {app.repo ? `${app.repo} · ` : ''}
            {app.branches.length} branch(es) tracked
          </p>
        </div>
        <div className="header-actions">
          <button className="ghost" onClick={() => void window.trymydev.refresh()}>
            Check for updates
          </button>
          <button
            className="ghost danger"
            onClick={() =>
              ask({
                title: `Remove ${app.name}`,
                message:
                  `Its ${app.branches.length} branch(es), their builds and the data shared ` +
                  'between them are deleted from this computer.',
                action: 'Remove',
                run: async () => {
                  await window.trymydev.removeApp(app.id)
                  await onReload()
                }
              })
            }
          >
            Remove
          </button>
        </div>
      </header>

      <FoldersCard app={app} />

      <div className="add">
        <input
          value={input}
          spellCheck={false}
          placeholder="Branch, fork or pull request URL"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addBranch()
          }}
        />
        <button className="primary" disabled={busy} onClick={() => void addBranch()}>
          {busy ? 'Adding…' : 'Add branch'}
        </button>
      </div>
      {addError && <div className="add-error">{addError}</div>}

      <div className="list">
        {app.branches.map((branch) => (
          <BranchCard
            key={branch.key}
            branch={branch}
            progress={progress[branch.key]}
            remoteSha={remote[branch.key]}
            onReload={onReload}
            ask={ask}
          />
        ))}
      </div>
    </>
  )
}

const FOLDERS_OPEN = 'trymydev.folders.open'

/** A remembered view choice; storage may be unavailable, and then nothing is remembered. */
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* not remembered */
  }
}

/** The application's folders the tester may point elsewhere, such as Modly's extensions. */
function FoldersCard({ app }: { app: AppView }): JSX.Element | null {
  const [folders, setFolders] = useState<FolderView[]>([])
  const [error, setError] = useState<string | null>(null)
  // Folded by default, one line; the choice is remembered for every application.
  const [open, setOpen] = useState(() => readPreference(FOLDERS_OPEN) === '1')

  useEffect(() => {
    let live = true
    setError(null)
    window.trymydev
      .folders(app.id)
      .then((list) => live && setFolders(list))
      .catch((err) => live && setError(clean(err)))
    return () => {
      live = false
    }
  }, [app.id, app.branches.length])

  if (folders.length === 0 && !error) return null

  const act = async (run: () => Promise<FolderView[]>): Promise<void> => {
    setError(null)
    try {
      setFolders(await run())
    } catch (err) {
      setError(clean(err))
    }
  }
  const origin: Record<FolderView['source'], string> = {
    installed: `Your ${app.name} installation's`,
    own: "TryMyDev's, shared by every branch",
    custom: 'A folder you picked'
  }
  const brief: Record<FolderView['source'], string> = { installed: app.name, own: 'TryMyDev', custom: 'your folder' }
  const toggle = (): void => {
    setOpen(!open)
    writePreference(FOLDERS_OPEN, open ? '0' : '1')
  }

  return (
    <div className={open ? 'card folders open' : 'card folders'}>
      <button type="button" className="folders-toggle" aria-expanded={open} onClick={toggle}>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
        <span className="folders-title">Folders</span>
        {!open && (
          <span className="folders-summary">
            {folders.map((folder) => `${folder.label}: ${brief[folder.source]}`).join(' · ')}
          </span>
        )}
      </button>
      {(open ? folders : []).map((folder) => (
        <div key={folder.id} className="folder">
          <div className="folder-text">
            <span className="folder-label">{folder.label}</span>
            <span className="folder-path" title={folder.path}>
              {folder.path}
            </span>
            <span className="folder-source">{origin[folder.source]} · used the next time a branch starts</span>
          </div>
          <div className="folder-actions">
            {folder.installed && folder.source !== 'installed' && (
              <button
                className="ghost"
                title={folder.installed}
                onClick={() => void act(() => window.trymydev.useFolder(app.id, folder.id, 'installed'))}
              >
                Use {app.name}
              </button>
            )}
            {folder.source !== 'own' && (
              <button className="ghost" onClick={() => void act(() => window.trymydev.useFolder(app.id, folder.id, 'own'))}>
                Use TryMyDev
              </button>
            )}
            <button className="ghost" onClick={() => void act(() => window.trymydev.chooseFolder(app.id, folder.id))}>
              Change…
            </button>
          </div>
        </div>
      ))}
      {error && <div className="add-error">{error}</div>}
    </div>
  )
}

function BranchCard({
  branch,
  progress,
  remoteSha,
  onReload,
  ask
}: {
  branch: BranchView
  progress?: StepProgress
  remoteSha?: string | null
  onReload: () => Promise<void>
  ask: Ask
}): JSX.Element {
  const status = useMemo(() => statusOf(branch, remoteSha), [branch, remoteSha])
  const elapsed = useElapsed(branch.busy && !branch.running ? progress?.since : undefined)

  return (
    <div className={branch.running ? 'card live' : 'card'}>
      <div className="row">
        <div className="ident">
          <span className="name">
            {branch.owner}/{branch.repo}
          </span>
          <span className="ref">
            {branch.ref}
            {branch.pr ? ` · PR #${branch.pr}` : ''}
          </span>
        </div>
        <span className={'badge ' + status.tone}>{status.label}</span>
      </div>

      {progress && (
        <div className="progress">
          <div className="progress-text">
            {progress.message}
            {elapsed && <span className="elapsed"> · {elapsed}</span>}
          </div>
          {progress.percent !== undefined && (
            <div className="bar">
              <span style={{ width: `${progress.percent}%` }} />
            </div>
          )}
          {progress.line && <div className="tail">{progress.line}</div>}
        </div>
      )}

      <div className="actions">
        {branch.running ? (
          <button className="primary" onClick={() => void window.trymydev.cancel(branch.key)}>
            Stop
          </button>
        ) : (
          <button
            className="primary"
            disabled={branch.busy}
            onClick={() => void window.trymydev.start(branch.key)}
          >
            {status.action}
          </button>
        )}
        {branch.busy && !branch.running && (
          <button className="ghost" onClick={() => void window.trymydev.cancel(branch.key)}>
            Cancel
          </button>
        )}
        {branch.running && branch.url && (
          <button className="ghost" onClick={() => void window.trymydev.openExternal(branch.url!)}>
            Open in browser
          </button>
        )}
        {window.trymydev.platform === 'win32' && <ShortcutButton branchKey={branch.key} />}
        <button
          className="ghost"
          onClick={() => void window.trymydev.openLogs(branch.appId, branch.key)}
        >
          Log
        </button>
        <button
          className="ghost danger"
          disabled={branch.busy || branch.running}
          onClick={() =>
            ask({
              title: `Delete ${branch.ref}`,
              message: `The sources, build and data of ${branch.label} are deleted from this computer.`,
              action: 'Delete',
              run: async () => {
                await window.trymydev.removeBranch(branch.key)
                await onReload()
              }
            })
          }
        >
          Delete
        </button>
        <span className="sha">{branch.builtSha ? branch.builtSha.slice(0, 7) : '—'}</span>
      </div>
    </div>
  )
}

/** Minutes and seconds since `since`, ticking while it is set. */
function useElapsed(since?: number): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  if (since === undefined) return null
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function statusOf(
  branch: BranchView,
  remoteSha?: string | null
): { label: string; tone: string; action: string } {
  if (branch.running) return { label: 'Running', tone: 'live', action: 'Run' }
  if (branch.busy) return { label: 'Preparing…', tone: 'work', action: 'Run' }
  if (!branch.builtSha) return { label: 'Never built', tone: 'new', action: 'Install and run' }
  if (remoteSha && remoteSha !== branch.builtSha) {
    return { label: 'Update available', tone: 'update', action: 'Update and run' }
  }
  return { label: 'Up to date', tone: 'ok', action: 'Run' }
}
