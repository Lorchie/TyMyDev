import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { branchKey, parseInput } from './source-url'

describe('parseInput', () => {
  it('reads a branch URL whose name contains slashes', () => {
    assert.deepEqual(
      parseInput('https://github.com/lightningpixel/modly/tree/feat/api-token-and-agent-guards'),
      { owner: 'lightningpixel', repo: 'modly', ref: 'feat/api-token-and-agent-guards' }
    )
  })

  it('decodes an encoded ref and drops a trailing slash', () => {
    assert.deepEqual(parseInput('https://github.com/o/r/tree/feat%2Fx/'), {
      owner: 'o',
      repo: 'r',
      ref: 'feat/x'
    })
  })

  it('reads a pull request URL, whatever tab it points at', () => {
    assert.deepEqual(parseInput('https://github.com/someone/modly/pull/42/files'), {
      owner: 'someone',
      repo: 'modly',
      pr: 42
    })
  })

  it('accepts a repository address without scheme, with www or with .git', () => {
    assert.deepEqual(parseInput('github.com/Comfy-Org/ComfyUI'), { owner: 'Comfy-Org', repo: 'ComfyUI' })
    assert.deepEqual(parseInput('https://www.github.com/Comfy-Org/ComfyUI.git'), {
      owner: 'Comfy-Org',
      repo: 'ComfyUI'
    })
  })

  it('reads the short forms', () => {
    assert.deepEqual(parseInput('owner/modly@my-branch'), { owner: 'owner', repo: 'modly', ref: 'my-branch' })
    assert.deepEqual(parseInput('owner/modly@feat/x'), { owner: 'owner', repo: 'modly', ref: 'feat/x' })
    assert.deepEqual(parseInput('owner/modly'), { owner: 'owner', repo: 'modly', ref: undefined })
  })

  it('ignores whitespace pasted around or inside the address', () => {
    assert.deepEqual(parseInput('  owner/modly @ dev \n'), { owner: 'owner', repo: 'modly', ref: 'dev' })
  })

  it('rejects an empty address', () => {
    assert.throws(() => parseInput('   '), /Empty address/)
  })

  it('rejects other hosts and look-alikes', () => {
    assert.throws(() => parseInput('https://gitlab.com/owner/repo'), /Unrecognised address/)
    assert.throws(() => parseInput('https://githubXcom/owner/repo'), /Unrecognised address/)
  })
})

describe('branchKey', () => {
  const key = (ref: string, extra: { owner?: string; repo?: string; appId?: string } = {}): string =>
    branchKey(extra.appId ?? 'app', { owner: extra.owner ?? 'o', repo: extra.repo ?? 'r', ref })

  it('is short: the ref, cut, and a hash', () => {
    assert.match(key('dev'), /^dev-[0-9a-f]{8}$/)
    assert.match(key('feat/api-token-and-agent-guards'), /^feat-api-token-and-agent-[0-9a-f]{8}$/)
    assert.ok(key('x'.repeat(200)).length <= 33)
  })

  it('stays a valid folder name whatever the ref', () => {
    assert.match(key('../..'), /^branch-[0-9a-f]{8}$/)
    assert.match(key('release/1.0.'), /^release-1\.0-[0-9a-f]{8}$/)
  })

  it('keeps apart refs a folder name would confuse, and other forks and applications', () => {
    assert.notEqual(key('fix/login'), key('fix-login'))
    assert.notEqual(key('Dev'), key('dev'))
    assert.notEqual(key('dev', { owner: 'fork' }), key('dev'))
    assert.notEqual(key('dev', { appId: 'other' }), key('dev'))
  })

  it('ignores the case of owner and repository, as GitHub does', () => {
    assert.equal(
      key('dev', { owner: 'Comfy-Org', repo: 'ComfyUI' }),
      key('dev', { owner: 'comfy-org', repo: 'comfyui' })
    )
  })
})
