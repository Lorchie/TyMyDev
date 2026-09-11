import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  folderPaths,
  manifestOfApp,
  missingChosen,
  refusedFolder,
  resolveFolders,
  type FolderSource,
  type FolderView
} from './folders'
import { writeJson } from './fsx'
import { checkoutDir, registryPath, shortRoot } from './paths'
import { cleanup, useUserData } from './testing'
import type { App, Manifest } from './types'

let data: string

before(() => {
  // The Electron stub answers every getPath with this folder: documents and appData included.
  data = useUserData()
})
after(() => cleanup(data))

const installedSpec = (key: string, usual: string) => ({ file: '{appData}/Tool/settings.json', key, usual })

const manifest: Manifest = {
  name: 'Tool',
  start: { mode: 'electron' },
  folders: [
    { id: 'extensions', label: 'Extensions', own: '{short}/ext', installed: installedSpec('extensionsDir', '{documents}/Tool/extensions'), use: 'installed' },
    { id: 'workflows', label: 'Workflows', own: '{shared}/workflows', installed: installedSpec('workflowsDir', '{documents}/Tool/workflows'), use: 'own' },
    { id: 'presets', label: 'Presets', own: '{shared}/presets', use: 'own' }
  ]
}
const app = (folders?: Record<string, string>): App => ({ id: 'tool', name: 'Tool', addedAt: '', folders })
const settings = (): string => join(data, 'Tool', 'settings.json')
const ours = (name: string): string => join(data, 'apps', 'tool', 'shared', name)

describe('resolveFolders', () => {
  it("uses TryMyDev's own folders while the application is not installed", async () => {
    const [extensions, workflows, presets] = await resolveFolders(app(), manifest)
    assert.equal(extensions.source, 'own', 'the installed one is wanted, but there is none')
    assert.ok(extensions.path.startsWith(shortRoot()))
    assert.equal(extensions.installed, undefined)
    assert.deepEqual(workflows, { id: 'workflows', label: 'Workflows', path: ours('workflows'), source: 'own', chosen: false })
    assert.deepEqual(presets, { id: 'presets', label: 'Presets', path: ours('presets'), source: 'own', chosen: false })
  })

  it('finds the installed application where its settings say, else where it usually keeps them', async () => {
    const named = join(data, 'D-drive', 'Tool', 'ext')
    writeJson(settings(), { extensionsDir: named, workflowsDir: 'relative/is/ignored' })
    mkdirSync(join(data, 'Tool', 'workflows'), { recursive: true })
    const [extensions, workflows] = await resolveFolders(app(), manifest)
    assert.deepEqual(extensions, { id: 'extensions', label: 'Extensions', path: named, source: 'installed', chosen: false, installed: named })
    assert.deepEqual(workflows, {
      id: 'workflows',
      label: 'Workflows',
      path: ours('workflows'),
      source: 'own',
      chosen: false,
      installed: join(data, 'Tool', 'workflows')
    })
  })

  it('switches either way on the tester’s word, and to a folder of their own', async () => {
    writeJson(settings(), { extensionsDir: join(data, 'installed-ext'), workflowsDir: join(data, 'installed-flows') })
    const mine = join(tmpdir(), 'my-presets')
    const [extensions, workflows, presets] = await resolveFolders(
      app({ extensions: 'own', workflows: 'installed', presets: mine }),
      manifest
    )
    assert.equal(extensions.source, 'own')
    assert.equal(extensions.chosen, true)
    assert.equal(extensions.installed, join(data, 'installed-ext'), 'still offered')
    assert.deepEqual([workflows.source, workflows.path, workflows.chosen], ['installed', join(data, 'installed-flows'), true])
    assert.deepEqual([presets.source, presets.path, presets.chosen], ['custom', mine, true])
    assert.deepEqual(folderPaths([workflows, presets]), { workflows: join(data, 'installed-flows'), presets: mine })
  })

  it('keeps pointing at the installed application once switched to it, even when it is gone', async () => {
    writeJson(settings(), {})
    const [, workflows] = await resolveFolders(app({ workflows: 'installed' }), manifest)
    assert.deepEqual([workflows.source, workflows.path], ['installed', join(data, 'Tool', 'workflows')])
  })

  it('has nothing to resolve for a manifest without folders', async () => {
    assert.deepEqual(await resolveFolders(app(), { name: 'Plain', start: { mode: 'electron' } }), [])
  })
})

describe('refusedFolder', () => {
  it('refuses the root of a disk, and folders TryMyDev deletes with a branch or an application', () => {
    assert.match(refusedFolder(parse(data).root) ?? '', /root of a disk/)
    assert.match(refusedFolder(join(data, 'apps', 'tool', 'branches', 'main-00000000')) ?? '', /belongs to TryMyDev/)
    assert.match(refusedFolder(data) ?? '', /belongs to TryMyDev/)
    assert.match(refusedFolder(join(shortRoot(), 'abcd', 'ext')) ?? '', /belongs to TryMyDev/)
    assert.equal(refusedFolder(join(tmpdir(), 'somewhere', 'Modly', 'extensions')), undefined)
    assert.equal(refusedFolder(`${data}-sibling`), undefined, 'a name that merely starts the same is not inside')
  })
})

describe('missingChosen', () => {
  it("finds a folder the tester switched to that is gone, never TryMyDev's own yet to be made", () => {
    const view = (source: FolderSource, chosen: boolean, path: string): FolderView => ({ id: source, label: source, source, chosen, path })
    assert.equal(missingChosen([view('own', true, join(data, 'not-yet'))]), undefined)
    assert.equal(missingChosen([view('installed', false, join(data, 'not-installed'))]), undefined)
    assert.equal(missingChosen([view('custom', true, data)]), undefined)
    assert.equal(missingChosen([view('custom', true, join(data, 'unplugged'))])?.path, join(data, 'unplugged'))
    assert.equal(missingChosen([view('installed', true, join(data, 'uninstalled'))])?.path, join(data, 'uninstalled'))
  })
})

describe('manifestOfApp', () => {
  it('reads the manifest of a fetched branch, and knows a built-in profile before any', () => {
    writeJson(registryPath(), {
      apps: [{ id: 'lightningpixel-modly', name: 'Modly', repo: 'lightningpixel/modly', addedAt: '' }],
      branches: [{ key: 'dev-00000000', appId: 'lightningpixel-modly', owner: 'lightningpixel', repo: 'modly', ref: 'dev', addedAt: '' }]
    })
    const modly: App = { id: 'lightningpixel-modly', name: 'Modly', repo: 'lightningpixel/modly', addedAt: '' }
    assert.equal(manifestOfApp(modly)?.folders?.[0].id, 'extensions', 'built-in profile, nothing fetched yet')

    const checkout = checkoutDir(modly.id, 'dev-00000000')
    mkdirSync(checkout, { recursive: true })
    writeJson(join(checkout, 'trymydev.json'), { name: 'Modly from the repository', start: { mode: 'electron' } })
    assert.equal(manifestOfApp(modly)?.name, 'Modly from the repository')

    assert.equal(manifestOfApp({ id: 'unknown', name: 'x', addedAt: '' }), undefined)
  })
})
