import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { placeSeeds, type SeedPlaces } from './seed'
import { cleanup, tempDir } from './testing'

let root: string
let places: SeedPlaces

before(() => {
  root = tempDir()
  places = {
    checkout: join(root, 'checkout'),
    data: join(root, 'data'),
    shared: join(root, 'shared'),
    short: join(root, 'short'),
    documents: join(root, 'documents'),
    appData: join(root, 'appdata'),
    venvPython: join(root, 'venvs', 'abc', 'Scripts', 'python.exe'),
    folders: { extensions: join(root, 'chosen', 'ext') }
  }
  mkdirSync(places.checkout, { recursive: true })
})
after(() => cleanup(root))

const read = (path: string): unknown => JSON.parse(readFileSync(join(places.data, path), 'utf-8'))

describe('placeSeeds', () => {
  it('writes a file once, pointing at the folders of the branch, and keeps what the application changed', async () => {
    const seeds = [
      { path: 'settings.json', json: { home: '{data}/home', ext: '{short}/ext', models: '{documents}/App/models', port: 3 } }
    ]
    await placeSeeds(seeds, places)
    assert.deepEqual(read('settings.json'), {
      home: join(places.data, 'home'),
      ext: join(places.short, 'ext'),
      models: join(places.documents, 'App', 'models'),
      port: 3
    })

    writeFileSync(join(places.data, 'settings.json'), '{"home":"chosen by the tester"}')
    await placeSeeds(seeds, places)
    assert.deepEqual(read('settings.json'), { home: 'chosen by the tester' })
  })

  it('rewrites a file marked always, with the digest of a file of the checkout', async () => {
    const seeds = [{ path: 'marker.json', json: { hash: '{sha256:api/requirements.txt}' }, always: true }]
    const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
    mkdirSync(join(places.checkout, 'api'))

    for (const requirements of ['fastapi\n', 'fastapi\ntrimesh\n']) {
      writeFileSync(join(places.checkout, 'api', 'requirements.txt'), requirements)
      await placeSeeds(seeds, places)
      assert.deepEqual(read('marker.json'), { hash: digest(requirements) })
    }
  })

  it('sets the keys of a merged file at every start, keeping what the application wrote beside them', async () => {
    const seeds = [
      { path: 'app.json', json: { models: '{documents}/App/models' } },
      { path: 'app.json', json: { extensions: '{folder:extensions}' }, merge: true }
    ]
    await placeSeeds(seeds, places)
    assert.deepEqual(read('app.json'), { models: join(places.documents, 'App', 'models'), extensions: join(root, 'chosen', 'ext') })

    writeFileSync(join(places.data, 'app.json'), JSON.stringify({ models: 'mine', token: 'kept', extensions: 'old' }))
    await placeSeeds(seeds, { ...places, folders: { extensions: join(root, 'other') } })
    assert.deepEqual(read('app.json'), { models: 'mine', token: 'kept', extensions: join(root, 'other') })
  })

  it('merges into a file the application broke, instead of failing to start', async () => {
    writeFileSync(join(places.data, 'broken.json'), '{ nope')
    await placeSeeds([{ path: 'broken.json', json: { home: '{appData}/App' }, merge: true }], places)
    assert.deepEqual(read('broken.json'), { home: join(places.appData, 'App') })
  })

  it('links a folder to the Python environment of the branch', async () => {
    await placeSeeds([{ path: 'dependencies/venv', link: '{venv}' }], places)
    assert.equal(realpathSync(join(places.data, 'dependencies', 'venv')), realpathSync(join(root, 'venvs', 'abc')))
  })

  it('explains a seed that needs what the branch does not have', async () => {
    await assert.rejects(
      placeSeeds([{ path: 'venv', link: '{venv}' }], { ...places, venvPython: undefined }),
      /prepares no Python environment/
    )
    await assert.rejects(
      placeSeeds([{ path: 'm.json', json: '{sha256:missing.txt}', always: true }], places),
      /missing\.txt, which the checkout does not have/
    )
    await assert.rejects(
      placeSeeds([{ path: 'x.json', json: '{folder:nowhere}', always: true }], places),
      /\{folder:nowhere\}, a folder the manifest does not declare/
    )
  })
})
