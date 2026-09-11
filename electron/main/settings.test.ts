import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { settingsPath } from './paths'
import { githubToken, hasGithubToken, setGithubToken } from './settings'
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
