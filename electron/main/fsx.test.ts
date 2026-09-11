import assert from 'node:assert/strict'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileDigest, hashString, linkDir, moveDir, readJson, removePath, removeTree, renameRetrying, writeJson } from './fsx'
import { cleanup, tempDir } from './testing'

const kind = process.platform === 'win32' ? 'junction' : 'dir'
let root: string
let count = 0

before(() => {
  root = tempDir()
})
after(() => cleanup(root))

/** A fresh folder per test inside the shared temporary root. */
function sandbox(): string {
  const dir = join(root, `case-${++count}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function put(path: string, content = 'keep'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('removeTree', () => {
  it('deletes a checkout without reaching the stores its links point at', async () => {
    const base = sandbox()
    const dependency = put(join(base, 'store', 'node_modules', 'pkg', 'index.js'))
    const model = put(join(base, 'shared', 'models', 'big.bin'))
    put(join(base, 'branch', 'checkout', 'main.js'))
    mkdirSync(join(base, 'branch', 'checkout', 'resources'))
    symlinkSync(join(base, 'store', 'node_modules'), join(base, 'branch', 'checkout', 'node_modules'), kind)
    symlinkSync(join(base, 'shared', 'models'), join(base, 'branch', 'checkout', 'resources', 'models'), kind)

    await removeTree(join(base, 'branch'))

    assert.equal(existsSync(join(base, 'branch')), false)
    assert.equal(readFileSync(dependency, 'utf-8'), 'keep')
    assert.equal(readFileSync(model, 'utf-8'), 'keep')
  })

  it('removes only the link when handed a link', async () => {
    const base = sandbox()
    const target = put(join(base, 'store', 'file.txt'))
    symlinkSync(join(base, 'store'), join(base, 'link'), kind)
    await removeTree(join(base, 'link'))
    assert.equal(existsSync(join(base, 'link')), false)
    assert.ok(existsSync(target))
  })

  it('accepts a path that does not exist', async () => {
    await removeTree(join(sandbox(), 'missing'))
    await removePath(join(sandbox(), 'missing'))
  })
})

describe('linkDir', () => {
  it('creates the target and links to it, and does nothing the second time', async () => {
    const base = sandbox()
    const link = join(base, 'checkout', 'node_modules')
    const target = join(base, 'store', 'node_modules')
    await linkDir(link, target)
    await linkDir(link, target)
    assert.ok(lstatSync(link).isSymbolicLink())
    put(join(target, 'dep.js'))
    assert.ok(existsSync(join(link, 'dep.js')))
  })

  it('points an existing link somewhere else', async () => {
    const base = sandbox()
    const link = join(base, 'link')
    await linkDir(link, join(base, 'first'))
    await linkDir(link, join(base, 'second'))
    assert.equal(realpathSync(link), realpathSync(join(base, 'second')))
    assert.ok(existsSync(join(base, 'first')), 'the former target is left alone')
  })

  it('replaces a dangling link whose store was deleted', async () => {
    const base = sandbox()
    const link = join(base, 'checkout', 'resources', 'python-embed')
    mkdirSync(join(base, 'old-store'))
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(base, 'old-store'), link, kind)
    await removePath(join(base, 'old-store'))
    assert.equal(existsSync(link), false, 'the link dangles')

    const target = join(base, 'new-store')
    await linkDir(link, target)
    put(join(target, 'python.exe'))
    assert.ok(existsSync(join(link, 'python.exe')))
  })

  it('replaces a real directory standing where the link goes', async () => {
    const base = sandbox()
    const link = put(join(base, 'checkout', 'models', 'placeholder.txt'))
    await linkDir(dirname(link), join(base, 'shared'))
    assert.ok(lstatSync(dirname(link)).isSymbolicLink())
  })
})

describe('moveDir', () => {
  it('moves a directory over whatever was at the destination', async () => {
    const base = sandbox()
    put(join(base, 'from', 'new.txt'), 'new')
    put(join(base, 'to', 'old.txt'), 'old')
    await moveDir(join(base, 'from'), join(base, 'to'))
    assert.equal(existsSync(join(base, 'from')), false)
    assert.equal(readFileSync(join(base, 'to', 'new.txt'), 'utf-8'), 'new')
    assert.equal(existsSync(join(base, 'to', 'old.txt')), false)
  })
})

describe('renameRetrying', () => {
  it('waits for a file held open inside the folder, as an antivirus holds a fresh one', { skip: process.platform !== 'win32' }, async () => {
    const base = sandbox()
    const held = openSync(put(join(base, 'from', 'scanned.dll')), 'r')
    setTimeout(() => closeSync(held), 400)
    await renameRetrying(join(base, 'from'), join(base, 'to'))
    assert.ok(existsSync(join(base, 'to', 'scanned.dll')))
  })

  it('fails at once for what waiting cannot fix', async () => {
    const base = sandbox()
    await assert.rejects(renameRetrying(join(base, 'missing'), join(base, 'to')), /ENOENT/)
  })
})

describe('hashes and JSON', () => {
  it('keeps the previous file whole when a write fails halfway', () => {
    const base = sandbox()
    const path = join(base, 'registry.json')
    writeJson(path, { apps: ['kept'] })
    // Something the temporary file cannot be written over — as a full disk refuses it.
    mkdirSync(`${path}.${process.pid}.tmp`)
    assert.throws(() => writeJson(path, { apps: [] }))
    assert.deepEqual(readJson(path, null), { apps: ['kept'] })
  })

  it('leaves no temporary file behind', () => {
    const base = sandbox()
    writeJson(join(base, 'state.json'), { sha: 'abc' })
    writeJson(join(base, 'state.json'), { sha: 'def' })
    assert.deepEqual(readdirSync(base), ['state.json'])
  })

  it('hashes a file and a string the same way', async () => {
    const file = put(join(sandbox(), 'data.txt'), 'hello')
    assert.equal(await fileDigest(file), hashString('hello'))
    assert.equal(hashString('hello').length, 64)
  })

  it('falls back when a JSON file is missing or corrupt, and writes into new folders', () => {
    const base = sandbox()
    assert.deepEqual(readJson(join(base, 'missing.json'), { fallback: true }), { fallback: true })
    put(join(base, 'broken.json'), '{ nope')
    assert.deepEqual(readJson(join(base, 'broken.json'), []), [])
    writeJson(join(base, 'deep', 'er', 'state.json'), { sha: 'abc' })
    assert.deepEqual(readJson(join(base, 'deep', 'er', 'state.json'), {}), { sha: 'abc' })
  })
})
