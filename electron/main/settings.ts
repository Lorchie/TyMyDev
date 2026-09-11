import { safeStorage } from 'electron'
import { readJson, writeJson } from './fsx'
import { settingsPath } from './paths'

interface SettingsFile {
  /** Sealed by the operating system (DPAPI, Keychain, libsecret), base64. */
  githubToken?: string
  autoCleanup?: boolean
  overlay?: boolean
}

/** What a tester can switch off, both on unless they did. */
export interface Preferences {
  /** Unused environments, leftovers and idle download caches removed when TryMyDev starts. */
  autoCleanup: boolean
  /** The tools overlay on tested applications — off as a way out if it ever troubles one. */
  overlay: boolean
}

export const PREFERENCE_NAMES = ['autoCleanup', 'overlay'] as const

export function preferences(): Preferences {
  const file = readJson<SettingsFile>(settingsPath(), {})
  return { autoCleanup: file.autoCleanup !== false, overlay: file.overlay !== false }
}

export function setPreference(name: keyof Preferences, value: boolean): Preferences {
  if (!PREFERENCE_NAMES.includes(name) || typeof value !== 'boolean') {
    throw new Error(`Unknown setting: ${String(name)}`)
  }
  const file = readJson<SettingsFile>(settingsPath(), {})
  file[name] = value
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
  const { githubToken: sealed } = readJson<SettingsFile>(settingsPath(), {})
  if (!sealed || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return undefined
  }
}

export function hasGithubToken(): boolean {
  return githubToken() !== undefined
}

export function setGithubToken(token: string | undefined): void {
  const file = readJson<SettingsFile>(settingsPath(), {})
  if (!token?.trim()) {
    delete file.githubToken
  } else {
    if (!sealable()) {
      throw new Error('This system offers no secure storage for the token, so it is not saved.')
    }
    file.githubToken = safeStorage.encryptString(token.trim()).toString('base64')
  }
  writeJson(settingsPath(), file)
}
