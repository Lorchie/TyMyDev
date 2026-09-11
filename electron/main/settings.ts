import { safeStorage } from 'electron'
import { readJson, writeJson } from './fsx'
import { settingsPath } from './paths'

interface SettingsFile {
  /** Sealed by the operating system (DPAPI, Keychain, libsecret), base64. */
  githubToken?: string
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
