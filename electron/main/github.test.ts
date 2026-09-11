import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { downloadTarball, headSha, rateLimit, resolveSource } from './github'
import { setGithubToken } from './settings'
import { cleanup, useUserData } from './testing'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const realFetch = globalThis.fetch
let calls: { url: string; headers: Record<string, string> }[] = []
let data: string

function mockFetch(handler: (url: string, headers: Record<string, string>) => Response): void {
  calls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, headers })
    return handler(url, headers)
  }) as typeof fetch
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

before(() => {
  data = useUserData()
})
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => cleanup(data))

describe('headSha', () => {
  const src = { owner: 'o', repo: 'r', ref: 'feat/x' }

  it('asks for the sha of an encoded ref, anonymously, and remembers its etag', async () => {
    mockFetch(() => new Response(`${SHA}\n`, { status: 200, headers: { etag: '"v1"' } }))
    assert.equal(await headSha(src), SHA)
    assert.match(calls[0].url, /\/repos\/o\/r\/commits\/feat%2Fx$/)
    assert.equal(calls[0].headers.Accept, 'application/vnd.github.sha')
    assert.equal(calls[0].headers.Authorization, undefined)
  })

  it('checks again for free: a 304 answers from the cache', async () => {
    mockFetch((_url, headers) =>
      headers['If-None-Match'] === '"v1"' ? new Response(null, { status: 304 }) : new Response('changed')
    )
    assert.equal(await headSha(src), SHA)
    assert.equal(calls.length, 1)
  })

  it('refuses an answer that is not a commit sha', async () => {
    mockFetch(() => new Response('<html>captive portal</html>', { status: 200 }))
    await assert.rejects(headSha({ ...src, ref: 'portal' }), /did not answer with a commit for o\/r@portal/)
  })

  it('explains a missing branch, with a single request', async () => {
    mockFetch(() => new Response('{}', { status: 404, statusText: 'Not Found' }))
    await assert.rejects(headSha({ ...src, ref: 'deleted' }), /Not found on GitHub[\s\S]*branch still exists/)
    assert.equal(calls.length, 1)
  })

  it('never takes an error page for a sha, nor asks twice', async () => {
    mockFetch(() => new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }))
    await assert.rejects(headSha({ ...src, ref: 'flaky' }), /GitHub answered 502 Bad Gateway/)
    assert.equal(calls.length, 1)
  })

  it('says when the anonymous rate limit is spent, for how long, and what lifts it', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600
    mockFetch(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
        })
    )
    await assert.rejects(
      headSha({ ...src, ref: 'limited' }),
      /rate limit reached[\s\S]*Try again in 10 minute[\s\S]*token in Settings/
    )
  })
})

describe('with a token in Settings', () => {
  before(() => setGithubToken('github_pat_test'))
  after(() => setGithubToken(undefined))

  it('authenticates every request', async () => {
    mockFetch(() => new Response(SHA))
    await headSha({ owner: 'o', repo: 'private', ref: 'main' })
    assert.equal(calls[0].headers.Authorization, 'Bearer github_pat_test')

    mockFetch(() => new Response(Buffer.alloc(8)))
    await downloadTarball({ owner: 'o', repo: 'private', ref: 'main' }, SHA, join(data, 'p.tar.gz'), () => undefined)
    assert.equal(calls[0].headers.Authorization, 'Bearer github_pat_test')
  })

  it('explains a token GitHub no longer accepts', async () => {
    mockFetch(() => new Response('{}', { status: 401, statusText: 'Unauthorized' }))
    await assert.rejects(headSha({ owner: 'o', repo: 'private', ref: 'x' }), /rejected the token saved in Settings/)
  })
})

describe('rateLimit', () => {
  it('reads the hourly limit a token grants', async () => {
    mockFetch(() => json({ resources: { core: { limit: 5000 } } }))
    assert.equal(await rateLimit('github_pat_x'), 5000)
    assert.equal(calls[0].headers.Authorization, 'Bearer github_pat_x')
  })

  it('refuses a token GitHub rejects', async () => {
    mockFetch(() => new Response('{}', { status: 401 }))
    await assert.rejects(rateLimit('bad'), /rejected this token/)
  })
})

describe('resolveSource', () => {
  it('resolves a fork to the root of its network and to its default branch', async () => {
    mockFetch(() =>
      json({ full_name: 'someone/modly', default_branch: 'main', source: { full_name: 'lightningpixel/modly' } })
    )
    assert.deepEqual(await resolveSource({ owner: 'someone', repo: 'modly' }), {
      source: { owner: 'someone', repo: 'modly', ref: 'main' },
      upstream: 'lightningpixel/modly'
    })
  })

  it('keeps the ref it was given, and follows a repository that moved', async () => {
    mockFetch(() => json({ full_name: 'Comfy-Org/ComfyUI', default_branch: 'master' }))
    assert.deepEqual(await resolveSource({ owner: 'comfyanonymous', repo: 'ComfyUI', ref: 'dev' }), {
      source: { owner: 'comfyanonymous', repo: 'ComfyUI', ref: 'dev' },
      upstream: 'Comfy-Org/ComfyUI'
    })
  })

  it('resolves a pull request to the branch of its fork, under the repository it targets', async () => {
    mockFetch(() =>
      json({
        head: { ref: 'fix', repo: { name: 'modly', owner: { login: 'someone' } } },
        base: { repo: { full_name: 'lightningpixel/modly' } }
      })
    )
    assert.deepEqual(await resolveSource({ owner: 'lightningpixel', repo: 'modly', pr: 7 }), {
      source: { owner: 'someone', repo: 'modly', ref: 'fix', pr: 7 },
      upstream: 'lightningpixel/modly'
    })
    assert.match(calls[0].url, /\/repos\/lightningpixel\/modly\/pulls\/7$/)
  })

  it('explains a pull request whose fork is gone', async () => {
    mockFetch(() => json({ head: { ref: 'fix', repo: null } }))
    await assert.rejects(resolveSource({ owner: 'o', repo: 'r', pr: 9 }), /fork deleted/)
  })

  it('refuses a repository without a default branch', async () => {
    mockFetch(() => json({ full_name: 'o/empty' }))
    await assert.rejects(resolveSource({ owner: 'o', repo: 'empty' }), /No default branch found for o\/empty/)
  })
})

describe('downloadTarball', () => {
  it('streams the archive to disk and reports progress', async () => {
    const body = Buffer.alloc(64 * 1024, 7)
    mockFetch(() => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }))
    const target = join(data, 'sources.tar.gz')
    const seen: number[] = []

    await downloadTarball({ owner: 'o', repo: 'r', ref: 'main' }, SHA, target, (received, total) => {
      assert.equal(total, body.length)
      seen.push(received)
    })

    assert.equal(readFileSync(target).length, body.length)
    assert.equal(seen.at(-1), body.length)
    assert.match(calls[0].url, new RegExp(`/repos/o/r/tarball/${SHA}$`))
  })

  it('fails on an error status', async () => {
    mockFetch(() => new Response('', { status: 404 }))
    await assert.rejects(
      downloadTarball({ owner: 'o', repo: 'r', ref: 'main' }, SHA, join(data, 'x.tar.gz'), () => undefined),
      /Could not download the sources \(HTTP 404\)/
    )
  })
})
