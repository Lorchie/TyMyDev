import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import {
  appDir,
  appSharedDir,
  branchDir,
  cacheDir,
  checkoutDir,
  nodeCacheDir,
  nodeModulesStore,
  pythonsDir,
  registryPath,
  shortDir,
  shortOwnerPath,
  shortRoot,
  statePath,
  storeDir,
  venvStore
} from './paths'
import { prune, usage } from './storage'
import { cleanup, useUserData } from './testing'

const kind = process.platform === 'win32' ? 'junction' : 'dir'
const MAIN = 'main-00000001'
const GONE = 'gone-00000002'
let data: string
let legacy: string

function put(path: string, size = 4): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x'.repeat(size))
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, kind)
}

before(() => {
  data = useUserData()
  legacy = join(storeDir(), 'python')
  writeJson(registryPath(), {
    apps: [{ id: 'app', name: 'App', addedAt: '' }],
    branches: [{ key: MAIN, appId: 'app', owner: 'o', repo: 'r', ref: 'main', addedAt: '' }]
  })
  writeJson(statePath('app', MAIN), { nodeKey: 'kept-node', pythonKey: 'kept-venv' })

  put(join(nodeModulesStore('kept-node'), 'dep', 'index.js'), 20_000)
  put(join(nodeModulesStore('stale-node'), 'dep', 'index.js'), 1_000)
  put(join(venvStore('stale-venv'), 'pyvenv.cfg'))
  mkdirSync(venvStore('kept-venv'), { recursive: true })
  writeFileSync(join(venvStore('kept-venv'), 'pyvenv.cfg'), `home = ${join(legacy, 'python-3.11.9')}\n`)

  put(join(storeDir(), 'node', 'node-22.23.2-win-x64', 'node.exe'))
  put(join(legacy, 'python-3.11.9', 'python.exe'), 100)
  put(join(pythonsDir(), 'cpython-3.13.7-windows-x86_64-none', 'python.exe'), 100)
  link(join(pythonsDir(), 'cpython-3.13.7-windows-x86_64-none'), join(pythonsDir(), 'cpython-3.13-windows-x86_64-none'))
  put(join(cacheDir('uv'), 'wheels', 'torch.whl'), 5_000)

  put(join(checkoutDir('app', MAIN), 'main.js'))
  link(nodeModulesStore('kept-node'), join(checkoutDir('app', MAIN), 'node_modules'))

  // A branch dropped from the registry whose checkout still links to a store in use.
  put(join(checkoutDir('app', GONE), 'main.js'))
  link(nodeModulesStore('kept-node'), join(checkoutDir('app', GONE), 'node_modules'))

  // Short folders: the application's, one a removed application left, and one another
  // profile of the same user owns.
  put(join(shortDir('app'), 'ext', 'torch.pyd'), 3_000)
  writeJson(shortOwnerPath(shortDir('app')), { root: data, appId: 'app' })
  put(join(shortDir('removed'), 'ext', 'torch.pyd'))
  writeJson(shortOwnerPath(shortDir('removed')), { root: data, appId: 'removed' })
  put(join(shortRoot(), 'else', 'ext', 'torch.pyd'))
  writeJson(shortOwnerPath(join(shortRoot(), 'else')), { root: join(data, 'another-profile'), appId: 'removed' })

  // An application dropped from the registry, with shared data of its own.
  put(join(appSharedDir('removed'), 'models', 'model.bin'))
  link(join(appSharedDir('removed'), 'models'), join(checkoutDir('removed', 'main-00000003'), 'models'))
})

after(() => cleanup(data))

describe('usage', () => {
  it('reports what nothing references as unused, largest first', async () => {
    const entries = await usage()
    const find = (label: RegExp): { orphan: boolean } | undefined => entries.find((e) => label.test(e.label))

    assert.equal(find(/^Node dependencies · stale-no/)?.orphan, true)
    assert.equal(find(/^Node dependencies · kept-nod/)?.orphan, false)
    assert.equal(find(/^Python environments · stale-ve/)?.orphan, true)
    assert.equal(find(/^Python environments · kept-ven/)?.orphan, false)
    assert.equal(find(new RegExp(`^App · removed branch ${GONE}$`))?.orphan, true)
    assert.equal(find(/^Removed application · removed$/)?.orphan, true)
    assert.equal(find(/^App · main$/)?.orphan, false)
    assert.equal(find(/^Runtime · node-22/)?.orphan, false)
    assert.equal(find(/^Download cache · uv$/)?.orphan, true)
    assert.equal(find(/^Runtime · Python \(earlier version\)$/)?.orphan, false, 'an environment still uses it')
    assert.equal(find(/^App · short-path folder$/)?.orphan, false)
    assert.equal(find(/^Removed application · removed · short-path folder$/)?.orphan, true)
    assert.equal(entries.some((e) => e.path === join(shortRoot(), 'else')), false, 'another profile owns it')
    for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].bytes >= entries[i].bytes)
  })

  it('counts a runtime once, not again through the link uv makes to it', async () => {
    const pythons = (await usage()).filter((e) => e.label.startsWith('Runtime · cpython-3.13'))
    assert.deepEqual(pythons.map((e) => e.label), ['Runtime · cpython-3.13.7-windows-x86_64-none'])
  })

  it('does not count a store once more for each branch linking to it', async () => {
    const branch = (await usage()).find((e) => e.label === 'App · main')
    assert.ok(branch && branch.bytes < 20_000, `branch counted ${branch?.bytes} bytes`)
  })
})

describe('prune', () => {
  it('removes unreferenced environments and leftover folders, never what a link points at', async () => {
    assert.ok((await prune()) > 0)

    assert.equal(existsSync(nodeCacheDir('stale-node')), false)
    assert.equal(existsSync(venvStore('stale-venv')), false)
    assert.equal(existsSync(branchDir('app', GONE)), false)
    assert.equal(existsSync(appDir('removed')), false)
    assert.equal(existsSync(shortDir('removed')), false)
    assert.ok(existsSync(join(shortDir('app'), 'ext', 'torch.pyd')))
    assert.ok(existsSync(join(shortRoot(), 'else', 'ext', 'torch.pyd')), 'the folder of another profile is kept')

    assert.ok(existsSync(join(nodeModulesStore('kept-node'), 'dep', 'index.js')))
    assert.ok(existsSync(venvStore('kept-venv')))
    assert.ok(existsSync(join(checkoutDir('app', MAIN), 'main.js')))
    assert.ok(existsSync(join(storeDir(), 'node', 'node-22.23.2-win-x64', 'node.exe')), 'runtimes are kept')
    assert.ok(existsSync(legacy), 'an earlier Python still in use is kept')
    assert.ok(existsSync(cacheDir('uv')), 'caches only go when asked')
  })

  it('removes the earlier Python once no environment is built on it', async () => {
    writeFileSync(join(venvStore('kept-venv'), 'pyvenv.cfg'), 'home = C:\\elsewhere\n')
    const entry = (await usage()).find((e) => e.label === 'Runtime · Python (earlier version)')
    assert.equal(entry?.orphan, true)
    await prune()
    assert.equal(existsSync(legacy), false)
  })

  it('has nothing left to remove the next time', async () => {
    assert.equal(await prune(), 0)
  })

  it('removes the download caches when asked', async () => {
    assert.ok((await prune({ caches: true })) >= 5_000)
    assert.equal(existsSync(cacheDir('uv')), false)
  })
})
