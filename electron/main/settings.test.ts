import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { settingsPath } from './paths'
import {
  agentToken,
  githubToken,
  hasGithubToken,
  preferences,
  renewAgentToken,
  setGithubToken,
  setPreference
} from './settings'
import { cleanup, useUserData } from './testing'

let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))

describe('GitHub token', () => {
  it('is absent by default', () => {
    assert.equal(githubToken(), undefined)
    assert.equal(hasGithubToken(), false)
  })

  it('is kept sealed, trimmed, and never in clear text', () => {
    setGithubToken('  github_pat_secret  ')
    assert.equal(githubToken(), 'github_pat_secret')
    assert.equal(hasGithubToken(), true)
    assert.ok(!readFileSync(settingsPath(), 'utf-8').includes('github_pat_secret'))
  })

  it('is removed, also by an empty value', () => {
    setGithubToken(undefined)
    assert.equal(hasGithubToken(), false)
    setGithubToken('github_pat_again')
    setGithubToken('   ')
    assert.equal(hasGithubToken(), false)
  })

  it('is not saved where the system cannot encrypt it', () => {
    process.env.TRYMYDEV_NO_ENCRYPTION = '1'
    try {
      assert.throws(() => setGithubToken('github_pat_x'), /no secure storage/)
      assert.equal(hasGithubToken(), false)
    } finally {
      delete process.env.TRYMYDEV_NO_ENCRYPTION
    }
  })

  it('is not saved on Linux when no keyring protects it', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.TRYMYDEV_STORAGE_BACKEND = 'basic_text'
    try {
      assert.throws(() => setGithubToken('github_pat_x'), /no secure storage/)
      process.env.TRYMYDEV_STORAGE_BACKEND = 'gnome_libsecret'
      assert.doesNotThrow(() => setGithubToken('github_pat_x'))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      delete process.env.TRYMYDEV_STORAGE_BACKEND
      setGithubToken(undefined)
    }
  })

  it('counts as absent once it can no longer be decrypted', () => {
    writeJson(settingsPath(), { githubToken: Buffer.from('from another machine').toString('base64') })
    assert.equal(githubToken(), undefined)
  })
})

describe('agent access', () => {
  it('is off until asked for, and gets a sealed token when switched on', () => {
    writeJson(settingsPath(), {})
    assert.equal(preferences().agent, false)
    assert.equal(agentToken(), undefined)
    setPreference('agent', true)
    const token = agentToken()
    assert.match(token ?? '', /^[\w-]{43}$/)
    assert.doesNotMatch(readFileSync(settingsPath(), 'utf-8'), new RegExp(token!))
  })

  it('keeps its token across switching off and on, until a new one is asked for', () => {
    const before = agentToken()
    setPreference('agent', false)
    setPreference('agent', true)
    assert.equal(agentToken(), before)
    const renewed = renewAgentToken()
    assert.notEqual(renewed, before)
    assert.equal(agentToken(), renewed)
  })

  it('cannot be switched on without secure storage', () => {
    writeJson(settingsPath(), {})
    process.env.TRYMYDEV_NO_ENCRYPTION = '1'
    try {
      assert.throws(() => setPreference('agent', true), /no secure storage/)
      assert.equal(preferences().agent, false)
    } finally {
      delete process.env.TRYMYDEV_NO_ENCRYPTION
    }
  })
})

describe('preferences', () => {
  it('are on until switched off, and kept beside the token', () => {
    writeJson(settingsPath(), { githubToken: 'sealed' })
    assert.deepEqual(preferences(), { autoCleanup: true, overlay: true, agent: false })
    assert.deepEqual(setPreference('overlay', false), { autoCleanup: true, overlay: false, agent: false })
    assert.deepEqual(setPreference('autoCleanup', false), { autoCleanup: false, overlay: false, agent: false })
    assert.equal(JSON.parse(readFileSync(settingsPath(), 'utf-8')).githubToken, 'sealed')
    assert.deepEqual(setPreference('overlay', true), { autoCleanup: false, overlay: true, agent: false })
  })

  it('refuses a name or a value it does not know', () => {
    assert.throws(() => setPreference('githubToken' as never, true), /Unknown setting: githubToken/)
    assert.throws(() => setPreference('overlay', 'no' as never), /Unknown setting: overlay/)
  })
})
