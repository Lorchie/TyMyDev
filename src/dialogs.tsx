import { useEffect, useState } from 'react'
import type { Approval, JobError, Settings, UsageEntry } from './env'

export function Modal({
  title,
  tone,
  onClose,
  children,
  actions
}: {
  title: string
  tone?: 'error'
  onClose: () => void
  children: React.ReactNode
  actions: React.ReactNode
}): JSX.Element {
  return (
    <div className="overlay" onClick={onClose}>
      <div className={tone ? `dialog ${tone}` : 'dialog'} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  )
}

export interface Confirmation {
  title: string
  message: string
  action: string
  run: () => Promise<void>
}

/** Asked before anything is deleted: shared data can weigh tens of gigabytes. */
export function ConfirmDialog({
  confirmation,
  onClose
}: {
  confirmation: Confirmation
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title={confirmation.title}
      onClose={onClose}
      actions={
        <>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await confirmation.run()
              } finally {
                onClose()
              }
            }}
          >
            {busy ? 'Deleting…' : confirmation.action}
          </button>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="message">{confirmation.message}</p>
    </Modal>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  repository: 'committed in the repository',
  provided: 'given to you by the developer',
  builtin: 'shipped with TryMyDev',
  detected: 'guessed from the project'
}

/**
 * A manifest is arbitrary commands, and the person running them is often not the
 * person who wrote them. Everything that will run is shown in full, once per
 * manifest — and again whenever it changes.
 */
export function ApprovalDialog({
  approval,
  branchKey,
  onClose,
  onApproved
}: {
  approval: Approval
  branchKey: string
  onClose: () => void
  onApproved: () => void
}): JSX.Element {
  return (
    <Modal
      title={`Review what ${approval.appName} will run`}
      onClose={onClose}
      actions={
        <>
          <button
            className="primary"
            onClick={() => {
              // The run itself takes minutes; its progress shows on the branch card.
              void window.trymydev.approve(approval.appId, approval.manifestHash, branchKey)
              onApproved()
            }}
          >
            Approve and run
          </button>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="message">
        These commands come from a manifest {SOURCE_LABEL[approval.source ?? 'detected']}, for{' '}
        <strong>{approval.repo}</strong>. They run on this computer with your account, and so does the
        code they start: the scripts of {approval.repo} and of its dependencies can read your files.
        Approving trusts {approval.repo} — its other branches and its future commits run without asking
        again, as long as these commands stay the same.
      </p>
      {approval.foreign && (
        <div className="hint warn">
          This code comes from {approval.repo}, not from {approval.upstream}. Approving lets what{' '}
          {approval.repo} publishes run these commands on this computer.
        </div>
      )}
      {approval.warnings.map((warning) => (
        <div className="hint warn" key={warning}>
          {warning}
        </div>
      ))}
      <div className="section">Commands</div>
      <pre className="log">{approval.commands.join('\n')}</pre>
      {approval.settings.length > 0 && (
        <>
          <div className="section">Settings</div>
          <pre className="log">{approval.settings.join('\n')}</pre>
        </>
      )}
      <div className="section">Downloads</div>
      <pre className="log">{approval.downloads.join('\n')}</pre>
    </Modal>
  )
}

export function ErrorDialog({
  error,
  onClose
}: {
  error: JobError
  onClose: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const report = [
    `Step: ${error.step}`,
    `Branch: ${error.key}`,
    '',
    error.message,
    ...(error.hint ? ['', `Hint: ${error.hint}`] : []),
    '',
    '--- log ---',
    error.logTail
  ].join('\n')

  return (
    <Modal
      title={`Failed — ${error.step}`}
      tone="error"
      onClose={onClose}
      actions={
        <>
          <button
            className="primary"
            onClick={() => {
              window.trymydev.copy(report)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy report'}
          </button>
          {error.logPath && (
            <button className="ghost" onClick={() => void window.trymydev.showItem(error.logPath)}>
              Open full log
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="message">{error.message}</p>
      {error.hint && <div className="hint">{error.hint}</div>}
      <pre className="log">{error.logTail || 'No output.'}</pre>
    </Modal>
  )
}

export function AddAppDialog({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: () => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [manifest, setManifest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.trymydev.addApp(url, manifest)
      onAdded()
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add an application"
      onClose={onClose}
      actions={
        <>
          <button className="primary" disabled={busy || url.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="message">
        Paste the address of a branch, a fork or a pull request. If its developer gave you a
        manifest, paste it too — otherwise TryMyDev works it out from the project.
      </p>
      <input
        autoFocus
        value={url}
        spellCheck={false}
        placeholder="https://github.com/owner/project/tree/my-branch"
        onChange={(e) => setUrl(e.target.value)}
      />
      <textarea
        value={manifest}
        spellCheck={false}
        rows={8}
        placeholder='Manifest (optional)&#10;{ "name": "…", "start": { "mode": "web", "run": "npm run dev" } }'
        onChange={(e) => setManifest(e.target.value)}
      />
      {error && <div className="add-error">{error}</div>}
    </Modal>
  )
}

export function StorageDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)
  const [freed, setFreed] = useState<number | null>(null)

  useEffect(() => {
    void window.trymydev.usage().then(setEntries)
  }, [])

  const total = (entries ?? []).reduce((sum, e) => sum + e.bytes, 0)

  return (
    <Modal
      title="Storage"
      onClose={onClose}
      actions={
        <>
          <button
            className="primary"
            onClick={async () => {
              setFreed(await window.trymydev.prune())
              setEntries(await window.trymydev.usage())
            }}
          >
            Remove what is unused
          </button>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {entries === null ? (
        <p className="message">Measuring…</p>
      ) : (
        <>
          <p className="message">
            {size(total)} in total{freed !== null ? ` — ${size(freed)} freed` : ''}
          </p>
          <div className="usage">
            {entries.map((entry) => (
              <div className="usage-row" key={entry.path}>
                <span className={entry.orphan ? 'usage-label orphan' : 'usage-label'}>
                  {entry.label}
                  {entry.orphan ? ' · unused' : ''}
                </span>
                <span className="usage-size">{size(entry.bytes)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

const pick = (settings: Settings): Pick<Settings, 'autoCleanup' | 'overlay' | 'agent' | 'agentError'> => ({
  autoCleanup: settings.autoCleanup,
  overlay: settings.overlay,
  agent: settings.agent,
  agentError: settings.agentError
})

/** The GitHub token: checked with GitHub before it is kept, never shown again. */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [saved, setSaved] = useState<boolean | null>(null)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [agentNote, setAgentNote] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Pick<Settings, 'autoCleanup' | 'overlay' | 'agent' | 'agentError'> | null>(null)

  useEffect(() => {
    void window.trymydev.getSettings().then((settings) => {
      setSaved(settings.githubToken)
      setPrefs(pick(settings))
    })
  }, [])

  const toggle = async (name: 'autoCleanup' | 'overlay' | 'agent', value: boolean): Promise<void> => {
    try {
      const settings = await window.trymydev.setPreference(name, value)
      setPrefs(pick(settings))
    } catch (err) {
      setStatus(clean(err))
    }
  }

  const apply = async (value: string | null): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.trymydev.setGithubToken(value)
      setSaved(result.githubToken)
      setToken('')
      setStatus(
        result.githubToken
          ? `Token saved — ${result.limit ?? '?'} GitHub requests an hour.`
          : 'Token removed — 60 GitHub requests an hour.'
      )
    } catch (err) {
      setStatus(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      actions={
        <>
          <button className="primary" disabled={busy || token.trim() === ''} onClick={() => void apply(token)}>
            {busy ? 'Checking…' : 'Save token'}
          </button>
          {saved && (
            <button className="ghost danger" disabled={busy} onClick={() => void apply(null)}>
              Remove token
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="section">GitHub token</div>
      <p className="message">
        Optional. Without one, GitHub allows 60 requests an hour and no private repository. Use a
        fine-grained token with read-only access to contents, and nothing more: it is stored
        encrypted for your account, which the applications you approve run under too.
      </p>
      <p className="message">{saved === null ? 'Checking…' : saved ? 'A token is saved.' : 'No token saved.'}</p>
      <input
        type="password"
        value={token}
        spellCheck={false}
        placeholder="github_pat_…"
        onChange={(e) => setToken(e.target.value)}
      />
      {status && <p className="message">{status}</p>}

      <div className="section">Storage</div>
      <label className="option">
        <input
          type="checkbox"
          checked={prefs?.autoCleanup ?? true}
          disabled={!prefs}
          onChange={(e) => void toggle('autoCleanup', e.target.checked)}
        />
        <span>
          Clean up when TryMyDev starts
          <small>
            Removes environments no branch uses any more, what removed branches left behind, and download caches
            unused for two weeks. Never your branches, models, extensions, workspace or workflows.
          </small>
        </span>
      </label>

      <div className="section">Tested applications</div>
      <label className="option">
        <input
          type="checkbox"
          checked={prefs?.overlay ?? true}
          disabled={!prefs}
          onChange={(e) => void toggle('overlay', e.target.checked)}
        />
        <span>
          Show the tools button on tested applications
          <small>
            The button in the corner of their window, with Report bug. Switch it off if an application ever misbehaves
            with it; it applies the next time a branch starts.
          </small>
        </span>
      </label>

      <div className="section">Agent access</div>
      <label className="option">
        <input
          type="checkbox"
          checked={prefs?.agent ?? false}
          disabled={!prefs}
          onChange={(e) => void toggle('agent', e.target.checked)}
        />
        <span>
          Let an agent test the applications
          <small>
            Claude Code, or another MCP client on this computer, can start branches, click and type in their windows,
            read their errors and log, and write bug reports. It never approves a manifest. It needs the tools button,
            and applies to branches started from now on.
          </small>
        </span>
      </label>
      {prefs?.agent && (
        <>
          {prefs.agentError && <p className="message">{prefs.agentError}</p>}
          <div className="row">
            <button
              className="ghost"
              onClick={() =>
                void window.trymydev
                  .copyAgentCommand()
                  .then(() => setAgentNote('Command copied: run it once in a terminal to add TryMyDev to Claude Code.'))
                  .catch((err) => setAgentNote(clean(err)))
              }
            >
              Copy the Claude Code command
            </button>
            <button
              className="ghost"
              onClick={() =>
                void window.trymydev
                  .renewAgentToken()
                  .then(() => setAgentNote('New token: the old one stops working. The new command is copied — run it again.'))
                  .catch((err) => setAgentNote(clean(err)))
              }
            >
              New token
            </button>
          </div>
          {agentNote && <p className="message">{agentNote}</p>}
        </>
      )}
    </Modal>
  )
}

export function size(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes > 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

/** Electron prefixes IPC rejections with "Error invoking remote method …". */
export function clean(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
