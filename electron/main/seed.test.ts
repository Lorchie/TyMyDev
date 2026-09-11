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
    venvPython: join(root, 'venvs', 'abc', 'Scripts', 'python.exe')
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
  })
})
