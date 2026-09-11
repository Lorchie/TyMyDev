import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as tar from 'tar'
import { BranchLog } from './logger'
import { manifestHash } from './manifest'
import { checkoutDir, nodeCacheDir, nodeModulesStore } from './paths'
import { ApprovalRequired, archiveGaps, provision, readState } from './provision'
import * as registry from './registry'
import { cleanup, installFakeNode, platformSlug, tempDir, useUserData } from './testing'
import type { App, Manifest } from './types'

// The whole pipeline against a fake GitHub: approval, sources, runtime, shared
// dependency store, build, cache and cancellation.

const INSTALL = `const fs = require('fs')
fs.mkdirSync('node_modules/dep', { recursive: true })
fs.writeFileSync('node_modules/dep/index.js', 'module.exports = "from dep"')
fs.appendFileSync(process.env.INSTALL_COUNTER, 'x')`
const BUILD = `require('fs').writeFileSync('built.txt', require('dep'))`

const realFetch = globalThis.fetch
const heads = new Map<string, string>()
const tarballs = new Map<string, Buffer>()
let tarballCalls = 0
let githubDown = false

let data: string
let work: string
let counter: string
let manifest: Manifest
let app: App

const sha = (char: string): string => char.repeat(40)
const installs = (): string => readFileSync(counter, 'utf-8')

async function publish(ref: string, commit: string, lock = '{"lockfileVersion":3}'): Promise<void> {
  const top = `o-r-${commit.slice(0, 7)}`
  const root = join(work, `src-${commit.slice(0, 7)}`)
  mkdirSync(join(root, top), { recursive: true })
  writeFileSync(join(root, top, 'package-lock.json'), lock)
  writeFileSync(join(root, top, 'install.js'), INSTALL)
  writeFileSync(join(root, top, 'build.js'), BUILD)
  const file = join(work, `${commit.slice(0, 7)}.tar.gz`)
  await tar.c({ gzip: true, file, cwd: root }, [top])
  tarballs.set(commit, readFileSync(file))
  heads.set(ref, commit)
}

async function prepare(ref: string, signal = new AbortController().signal): Promise<{ key: string; events: string[] }> {
  const branch = registry.addBranch(app.id, { owner: 'o', repo: 'r', ref })
  const events: string[] = []
  await provision(
    registry.getApp(app.id),
    branch,
    new BranchLog(app.id, branch.key),
    (step, message) => events.push(`${step}: ${message}`),
    signal
  )
  return { key: branch.key, events }
}

const approve = (m: Manifest): void => registry.approveApp(app.id, manifestHash(m), { owner: 'o', repo: 'r', ref: 'main' })

before(async () => {
  data = useUserData()
  work = tempDir()
  counter = join(work, 'installs')
  writeFileSync(counter, '')
  installFakeNode('22.23.2')

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (githubDown) return new Response('down', { status: 503, statusText: 'Service Unavailable' })
    const commit = url.match(/\/commits\/([^/]+)$/)
    if (commit) {
      const head = heads.get(decodeURIComponent(commit[1]))
      return head ? new Response(head) : new Response('{}', { status: 404, statusText: 'Not Found' })
    }
    const tarball = url.match(/\/tarball\/(\w+)$/)
    if (tarball) {
      tarballCalls++
      const body = tarballs.get(tarball[1])
      return body ? new Response(body) : new Response('', { status: 404 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  manifest = {
    name: 'Fake',
    runtime: { node: '22' },
    install: [{ run: 'node install.js' }],
    build: [{ run: 'node build.js' }],
    start: { mode: 'command', run: 'node -e 0' },
    env: { INSTALL_COUNTER: counter }
  }
  app = registry.addApp('o/r', manifest)
  await publish('main', sha('a'))
})

after(async () => {
  globalThis.fetch = realFetch
  await cleanup(work, data)
})

describe('provision', () => {
  it('stops for approval before running anything', async () => {
    const branch = registry.addBranch(app.id, { owner: 'o', repo: 'r', ref: 'main' })
    await assert.rejects(
      provision(registry.getApp(app.id), branch, new BranchLog(app.id, branch.key), () => undefined, new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequired)
        assert.deepEqual(err.approval.commands, ['node install.js', 'node build.js', 'node -e 0'])
        return true
      }
    )
    assert.equal(installs(), '')
    assert.equal(tarballCalls, 1)
    assert.ok(existsSync(join(checkoutDir(app.id, branch.key), 'install.js')))
    assert.equal(readState(app.id, branch.key).builtSha, undefined)
  })

  it('once approved, installs into the shared store and builds, without downloading again', async () => {
    approve(manifest)
    const { key } = await prepare('main')
    const state = readState(app.id, key)
    const checkout = checkoutDir(app.id, key)

    assert.equal(tarballCalls, 1)
    assert.equal(installs(), 'x')
    assert.equal(state.builtSha, sha('a'))
    assert.ok(state.nodeKey)
    assert.ok(existsSync(join(nodeCacheDir(state.nodeKey), '.installed')))
    assert.ok(existsSync(join(nodeModulesStore(state.nodeKey), 'dep', 'index.js')))
    assert.ok(lstatSync(join(checkout, 'node_modules')).isSymbolicLink())
    assert.equal(readFileSync(join(checkout, 'built.txt'), 'utf-8'), 'from dep')
  })

  it('starts at once when the branch has not moved', async () => {
    const { events } = await prepare('main')
    assert.ok(events.includes(`done: Already up to date (${sha('a').slice(0, 7)}) — starting now`), events.join('\n'))
    assert.equal(installs(), 'x')
    assert.equal(tarballCalls, 1)
  })

  it('starts the cached build when GitHub cannot be reached', async () => {
    githubDown = true
    try {
      const { events } = await prepare('main')
      assert.ok(events.some((e) => e.startsWith('done: Already up to date')))
    } finally {
      githubDown = false
    }
  })

  it('downloads and builds a new commit, reusing the installed dependencies', async () => {
    await publish('main', sha('b'))
    const { key, events } = await prepare('main')
    assert.equal(tarballCalls, 2)
    assert.equal(installs(), 'x')
    assert.ok(events.includes('install: Dependencies already cached'))
    assert.equal(readState(app.id, key).builtSha, sha('b'))
    assert.ok(existsSync(join(checkoutDir(app.id, key), 'built.txt')))
  })

  it('installs nothing for another branch on the same lockfile', async () => {
    await publish('feature', sha('c'))
    const main = readState(app.id, registry.addBranch(app.id, { owner: 'o', repo: 'r', ref: 'main' }).key)
    const { key } = await prepare('feature')

    assert.equal(installs(), 'x')
    assert.equal(readState(app.id, key).nodeKey, main.nodeKey)
    assert.equal(
      realpathSync(join(checkoutDir(app.id, key), 'node_modules')),
      realpathSync(nodeModulesStore(main.nodeKey!))
    )
  })

  it('gives a different lockfile its own environment', async () => {
    await publish('upgrade', sha('d'), '{"lockfileVersion":3,"packages":{"dep":"2"}}')
    const main = readState(app.id, registry.addBranch(app.id, { owner: 'o', repo: 'r', ref: 'main' }).key)
    const { key } = await prepare('upgrade')
    assert.equal(installs(), 'xx')
    assert.notEqual(readState(app.id, key).nodeKey, main.nodeKey)
  })

  it('asks again when the commands change, then installs a separate environment', async () => {
    const changed: Manifest = { ...manifest, install: [...(manifest.install ?? []), { run: 'node -e 0' }] }
    registry.addApp('o/r', changed)
    const before = readState(app.id, registry.addBranch(app.id, { owner: 'o', repo: 'r', ref: 'main' }).key)

    await assert.rejects(prepare('main'), ApprovalRequired)
    approve(changed)
    const { key } = await prepare('main')

    assert.equal(installs(), 'xxx')
    assert.notEqual(readState(app.id, key).nodeKey, before.nodeKey)
    assert.equal(tarballCalls, 4, 'the commit already on disk is not downloaded again')
  })

  it('uses the runtime from the store', async () => {
    const branch = registry.addBranch(app.id, { owner: 'o', repo: 'r', ref: 'main' })
    const { toolchain } = await provision(
      registry.getApp(app.id),
      branch,
      new BranchLog(app.id, branch.key),
      () => undefined,
      new AbortController().signal
    )
    assert.equal(toolchain.node?.id, `node-22.23.2-${platformSlug}`)
  })

  it('explains an unknown branch that was never built', async () => {
    await assert.rejects(prepare('missing'), /Not found on GitHub/)
  })

  it('stops a cancelled job before it runs anything', async () => {
    await publish('cancelled', sha('e'), '{"lockfileVersion":3,"cancelled":true}')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(prepare('cancelled', controller.signal), { name: 'AbortError' })
    assert.equal(installs(), 'xxx')
  })

  it('skips the steps meant for other machines', async () => {
    process.env.TRYMYDEV_GPU = 'none'
    try {
      const gated: Manifest = {
        ...manifest,
        install: [{ run: 'node -e "process.exit(9)"', when: { gpu: 'nvidia' } }, ...(manifest.install ?? [])]
      }
      registry.addApp('o/r', gated)
      approve(gated)
      await publish('gated', sha('f'), '{"lockfileVersion":3,"gated":true}')
      await prepare('gated')
      assert.equal(installs(), 'xxxx')
    } finally {
      delete process.env.TRYMYDEV_GPU
    }
  })

  it('asks again before running the same manifest on code from another repository', async () => {
    await publish('stranger', sha('9'))
    const branch = registry.addBranch(app.id, { owner: 'stranger', repo: 'r', ref: 'stranger' })
    await assert.rejects(
      provision(registry.getApp(app.id), branch, new BranchLog(app.id, branch.key), () => undefined, new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequired)
        assert.equal(err.approval.foreign, true)
        assert.equal(err.approval.repo, 'stranger/r')
        assert.equal(err.approval.upstream, 'o/r')
        assert.deepEqual(err.approval.warnings, [])
        return true
      }
    )
    assert.equal(installs(), 'xxxx', 'nothing ran')
  })
})

describe('archiveGaps', () => {
  it('warns about what GitHub archives leave out: submodules and Git LFS content', () => {
    const plain = tempDir()
    const gappy = tempDir()
    writeFileSync(join(gappy, '.gitmodules'), '[submodule "vendor/lib"]\n')
    writeFileSync(join(gappy, '.gitattributes'), '*.safetensors filter=lfs diff=lfs merge=lfs -text\n')
    try {
      assert.deepEqual(archiveGaps(plain), [])
      const gaps = archiveGaps(gappy)
      assert.equal(gaps.length, 2)
      assert.match(gaps[0], /submodules/)
      assert.match(gaps[1], /Git LFS/)
    } finally {
      void cleanup(plain, gappy)
    }
  })
})
