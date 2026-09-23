import { safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import { readJson, writeJson } from './fsx'
import { settingsPath } from './paths'

interface SettingsFile {
  /** Sealed by the operating system (DPAPI, Keychain, libsecret), base64. */
  githubToken?: string
  autoCleanup?: boolean
  overlay?: boolean
  agent?: boolean
  /** Sealed like the GitHub token. */
  agentToken?: string
}

/** What a tester can switch off, on unless they did — but agent access, off unless they asked. */
export interface Preferences {
  /** Unused environments, leftovers and idle download caches removed when TryMyDev starts. */
  autoCleanup: boolean
  /** The tools overlay on tested applications — off as a way out if it ever troubles one. */
  overlay: boolean
  /** An agent — Claude Code, say — may drive the applications TryMyDev starts. */
  agent: boolean
}

export const PREFERENCE_NAMES = ['autoCleanup', 'overlay', 'agent'] as const

export function preferences(): Preferences {
  const file = readJson<SettingsFile>(settingsPath(), {})
  return { autoCleanup: file.autoCleanup !== false, overlay: file.overlay !== false, agent: file.agent === true }
}

export function setPreference(name: keyof Preferences, value: boolean): Preferences {
  if (!PREFERENCE_NAMES.includes(name) || typeof value !== 'boolean') {
    throw new Error(`Unknown setting: ${String(name)}`)
  }
  const file = readJson<SettingsFile>(settingsPath(), {})
  file[name] = value
  if (name === 'agent' && value && !unseal(file.agentToken)) file.agentToken = seal(newAgentToken())
  writeJson(settingsPath(), file)
  return preferences()
}

/** Linux without a keyring falls back to a key hardcoded in Chromium, which protects nothing. */
function sealable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

/**
 * Optional GitHub token: 5,000 requests an hour instead of 60, and private repositories.
 * Only the operating system can read it back; an unreadable one counts as none.
 */
export function githubToken(): string | undefined {
  return unseal(readJson<SettingsFile>(settingsPath(), {}).githubToken)
}

function unseal(sealed: string | undefined): string | undefined {
  if (!sealed || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return undefined
  }
}

function seal(secret: string): string {
  if (!sealable()) throw new Error('This system offers no secure storage for the token, so it is not saved.')
  return safeStorage.encryptString(secret).toString('base64')
}

const newAgentToken = (): string => randomBytes(32).toString('base64url')

/**
 * What an agent presents to drive the applications: made when agent access is switched on,
 * kept until the tester asks for a new one.
 */
export function agentToken(): string | undefined {
  return unseal(readJson<SettingsFile>(settingsPath(), {}).agentToken)
}

/** The previous token stops working at once: every agent configured with it must be given the new one. */
export function renewAgentToken(): string {
  const file = readJson<SettingsFile>(settingsPath(), {})
  const token = newAgentToken()
  file.agentToken = seal(token)
  writeJson(settingsPath(), file)
  return token
}

export function hasGithubToken(): boolean {
  return githubToken() !== undefined
}

export function setGithubToken(token: string | undefined): void {
  const file = readJson<SettingsFile>(settingsPath(), {})
  if (!token?.trim()) {
    delete file.githubToken
  } else {
    file.githubToken = seal(token.trim())
  }
  writeJson(settingsPath(), file)
}
