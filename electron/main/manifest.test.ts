import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { approvalOf, commandsOf, manifestHash, resolveManifest, startFor, stepsFor, validate, wants } from './manifest'
import { cleanup, tempDir } from './testing'
import type { App, Manifest } from './types'

const minimal = { name: 'App', start: { mode: 'web', run: 'npm run dev' } }
const parse = (value: unknown): Manifest => validate(JSON.stringify(value), 'test')
const invalid = (value: unknown, message: RegExp): void => {
  assert.throws(() => parse(value), message)
}

function withGpu<T>(gpu: string, fn: () => T): T {
  const previous = process.env.TRYMYDEV_GPU
  process.env.TRYMYDEV_GPU = gpu
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.TRYMYDEV_GPU
    else process.env.TRYMYDEV_GPU = previous
  }
}

describe('validate', () => {
  it('accepts a minimal manifest', () => {
    assert.equal(parse(minimal).name, 'App')
  })

  it('rejects text that is not JSON, naming where it came from', () => {
    assert.throws(() => validate('{ nope', 'the manifest you pasted'), /the manifest you pasted is not valid JSON/)
  })

  it('requires a name and a start', () => {
    invalid({ start: minimal.start }, /"name" is required/)
    invalid({ name: '  ', start: minimal.start }, /"name" is required/)
    invalid({ name: 'App' }, /"start" is required/)
  })

  it('requires a known start mode, and a command for web and command modes', () => {
    invalid({ name: 'App', start: { mode: 'docker' } }, /"start.mode" must be/)
    invalid({ name: 'App', start: { mode: 'web' } }, /"start.run" is required for mode web/)
    invalid({ name: 'App', start: { mode: 'command' } }, /"start.run" is required for mode command/)
    assert.equal(startFor(parse({ name: 'App', start: { mode: 'electron' } })).mode, 'electron')
  })

  it('requires steps to be lists of commands', () => {
    invalid({ ...minimal, install: 'npm install' }, /"install" must be a list/)
    invalid({ ...minimal, build: [{ cmd: 'npm run build' }] }, /every "build" entry needs a "run" string/)
  })

  it('keeps every path a manifest points at inside the project', () => {
    for (const path of ['', '.', './', '..', '../outside', 'a/../../b', 'C:\\Users', 'C:foo', '/etc', 42]) {
      invalid({ ...minimal, share: [{ path }] }, /"share" path must be a relative path inside the project/)
    }
    invalid({ ...minimal, install: [{ run: 'x', cwd: '../up' }] }, /"install" cwd must be a relative path/)
    invalid({ ...minimal, isolate: [{ env: 'HOME', dir: '..' }] }, /"isolate" dir must be a relative path/)
    assert.equal(parse({ ...minimal, share: [{ path: 'resources/python-embed' }, { path: './models' }] }).share?.length, 2)
  })

  it('requires isolate entries to name a variable, and env to hold strings', () => {
    invalid({ ...minimal, isolate: [{ dir: 'home' }] }, /every "isolate" entry needs an "env" name/)
    invalid({ ...minimal, env: { PORT: 8188 } }, /"env" must map variable names to strings/)
    invalid({ ...minimal, env: ['A=1'] }, /"env" must map variable names to strings/)
    invalid({ ...minimal, share: 'models' }, /"share" must be a list/)
    invalid({ ...minimal, share: [{ path: 'models', env: 3 }] }, /"share" env must be a variable name/)
  })

  it('checks the shape of the repository', () => {
    invalid({ ...minimal, repo: 'just-a-name' }, /"repo" must look like owner\/name/)
    for (const repo of ['-/..', 'owner/.', 'own er/repo', 'owner/re:po', 42]) {
      invalid({ ...minimal, repo }, /"repo" must look like owner\/name/)
    }
    assert.equal(parse({ ...minimal, repo: 'Comfy-Org/ComfyUI' }).repo, 'Comfy-Org/ComfyUI')
  })
})

describe('conditions', () => {
  const gated = {
    name: 'Gpu',
    start: { mode: 'command', run: 'python main.py' },
    install: [
      { run: 'pip install torch --extra-index-url cuda', when: { gpu: 'nvidia' } },
      { run: 'pip install torch --index-url rocm', when: { gpu: 'amd', platform: 'linux' } },
      { run: 'pip install -r requirements.txt' }
    ]
  }

  it('accepts platform and gpu, alone or as lists', () => {
    assert.doesNotThrow(() =>
      parse({ ...minimal, build: [{ run: 'y', when: { platform: ['windows', 'linux'], gpu: ['amd', 'none'] } }] })
    )
    assert.doesNotThrow(() => parse(gated))
  })

  it('rejects a misspelt condition rather than run the step everywhere', () => {
    invalid({ ...minimal, install: [{ run: 'x', when: { os: 'windows' } }] }, /unknown condition "os"/)
    invalid({ ...minimal, install: [{ run: 'x', when: { gpu: 'cuda' } }] }, /"install" when\.gpu must be nvidia, amd, none/)
    invalid({ ...minimal, build: [{ run: 'x', when: { platform: [] } }] }, /"build" when\.platform must be windows, macos, linux/)
    invalid({ ...minimal, install: [{ run: 'x', when: 'nvidia' }] }, /"install" when must be an object/)
  })

  it('shows and runs only the steps meant for this machine', () => {
    const m = parse(gated)
    assert.deepEqual(withGpu('nvidia', () => commandsOf(m)), [
      'pip install torch --extra-index-url cuda',
      'pip install -r requirements.txt',
      'python main.py'
    ])
    assert.deepEqual(withGpu('none', () => stepsFor(m.install).map((s) => s.run)), ['pip install -r requirements.txt'])
  })

  it('hashes the whole manifest, whatever machine reads it', () => {
    const m = parse(gated)
    assert.equal(withGpu('nvidia', () => manifestHash(m)), withGpu('amd', () => manifestHash(m)))
  })
})

describe('start variants', () => {
  const variants = {
    name: 'Comfy',
    start: [
      { mode: 'web', run: 'python main.py --port {port}', port: 8188, when: { gpu: 'nvidia' } },
      { mode: 'web', run: 'python main.py --cpu --port {port}', port: 8188 }
    ]
  }

  it('uses the first start whose condition matches this machine', () => {
    const m = parse(variants)
    assert.equal(withGpu('nvidia', () => (startFor(m) as { run: string }).run), 'python main.py --port {port}')
    assert.equal(withGpu('none', () => (startFor(m) as { run: string }).run), 'python main.py --cpu --port {port}')
    assert.deepEqual(withGpu('none', () => commandsOf(m)), ['python main.py --cpu --port {port}'])
  })

  it('explains a manifest that has no start for this machine', () => {
    const m = parse({ name: 'Gpu only', start: [{ mode: 'command', run: 'x', when: { gpu: 'nvidia' } }] })
    assert.throws(() => withGpu('none', () => startFor(m)), /Gpu only has no start for this machine/)
  })

  it('checks every variant', () => {
    invalid({ name: 'A', start: [] }, /"start" is required/)
    invalid({ name: 'A', start: [{ mode: 'web', run: 'x' }, { mode: 'web' }] }, /"start\[1\]\.run" is required for mode web/)
    invalid({ name: 'A', start: [{ mode: 'command', run: 'x', when: { gpu: 'cuda' } }] }, /"start\[0\]" when\.gpu must be/)
  })
})

describe('approval of code from another repository', () => {
  it('warns when the code does not come from the application repository', () => {
    const m = parse(minimal)
    const app: App = { id: 'o-r', name: 'R', repo: 'Owner/R', addedAt: '' }
    const own = approvalOf(app, m, { owner: 'owner', repo: 'r', ref: 'main' })
    const stranger = approvalOf(app, m, { owner: 'stranger', repo: 'r', ref: 'evil' })
    assert.equal(own.foreign, false)
    assert.equal(stranger.foreign, true)
    assert.equal(stranger.repo, 'stranger/r')
    assert.equal(stranger.upstream, 'Owner/R')
  })
})

describe('wants', () => {
  const m = (extra: Partial<Manifest>): Manifest => ({
    name: 'App',
    start: { mode: 'command', run: 'true' },
    ...extra
  })

  it('follows an explicit runtime request', () => {
    assert.equal(wants(m({ runtime: { python: '3.11' } }), 'python'), true)
    assert.equal(wants(m({ runtime: { python: '3.11' } }), 'node'), false)
  })

  it('infers runtimes from the steps, the start line and Electron', () => {
    assert.equal(wants(m({ build: [{ run: 'npx vite build' }] }), 'node'), true)
    assert.equal(wants(m({ start: { mode: 'web', run: 'python3 main.py' } }), 'python'), true)
    assert.equal(wants(m({ install: [{ run: 'uv sync' }] }), 'python'), true)
    assert.equal(wants(m({ start: { mode: 'electron' } }), 'node'), true)
  })

  it('does not mistake a longer tool name for one it provides', () => {
    assert.equal(wants(m({ install: [{ run: 'npmx install' }] }), 'node'), false)
    assert.equal(wants(m({ install: [{ run: 'pipenv install' }] }), 'python'), false)
  })

  it('ignores the steps meant for other machines', () => {
    const gated = m({ install: [{ run: 'node setup-cuda.js', when: { gpu: 'nvidia' } }] })
    assert.equal(withGpu('none', () => wants(gated, 'node')), false)
    assert.equal(withGpu('nvidia', () => wants(gated, 'node')), true)
  })
})

describe('seed', () => {
  const settings = { path: 'settings.json', json: { home: '{data}/home', hash: '{sha256:api/requirements.txt}' } }

  it('accepts files and links built from the folders it knows', () => {
    const m = parse({ ...minimal, seed: [settings, { path: 'deps/venv', link: '{venv}' }, { ...settings, always: true }] })
    assert.equal(m.seed?.length, 3)
  })

  it('needs a file or a link, inside the data folder', () => {
    invalid({ ...minimal, seed: 'settings.json' }, /"seed" must be a list/)
    invalid({ ...minimal, seed: [{ path: 'a.json' }] }, /needs either "json" or "link"/)
    invalid({ ...minimal, seed: [{ path: 'a', json: {}, link: '{data}' }] }, /needs either "json" or "link"/)
    invalid({ ...minimal, seed: [{ path: '../a.json', json: {} }] }, /"seed" path must be a relative path/)
    invalid({ ...minimal, seed: [{ ...settings, always: 'yes' }] }, /"always" must be true or false/)
  })

  it('refuses a link to anywhere else on the disk', () => {
    for (const link of ['C:\\Windows', '/etc', 'relative', '{data}/../..', '{home}']) {
      invalid({ ...minimal, seed: [{ path: 'x', link }] }, /"link" must start with \{data\}/)
    }
  })

  it('rejects a misspelt placeholder, and a digest of a file outside the project', () => {
    invalid({ ...minimal, seed: [{ path: 'a.json', json: { dir: ['{datta}/x'] } }] }, /unknown placeholder \{datta\}/)
    invalid({ ...minimal, seed: [{ path: 'a.json', json: '{data:x}' }] }, /unknown placeholder \{data:x\}/)
    invalid({ ...minimal, seed: [{ path: 'a.json', json: '{sha256:../secret}' }] }, /must be a relative path inside/)
  })

  it('shows every seed, with its content, before approval', () => {
    const m = parse({ ...minimal, seed: [settings, { path: 'deps/venv', link: '{venv}' }] })
    assert.deepEqual(approvalOf({ id: 'o-r', name: 'R', addedAt: '' }, m, { owner: 'o', repo: 'r', ref: 'main' }).settings, [
      `file in the data folder, once: settings.json = ${JSON.stringify(settings.json)}`,
      'link in the data folder: deps/venv → {venv}'
    ])
  })

  it('merges the keys of an object, and never together with always', () => {
    const merged = { path: 'settings.json', json: { ext: '{appData}/App/ext' }, merge: true }
    assert.equal(parse({ ...minimal, seed: [merged] }).seed?.[0].merge, true)
    invalid({ ...minimal, seed: [{ ...merged, merge: 'yes' }] }, /"merge" must be true or false/)
    invalid({ ...minimal, seed: [{ ...merged, always: true }] }, /cannot go with "always"/)
    invalid({ ...minimal, seed: [{ path: 'a.json', json: ['x'], merge: true }] }, /needs "json" to be an object/)
  })
})

describe('folders', () => {
  const extensions = {
    id: 'extensions',
    label: 'Extensions',
    own: '{short}/ext',
    installed: { file: '{appData}/App/settings.json', key: 'extensionsDir', usual: '{documents}/App/extensions' },
    use: 'installed'
  }

  it('declares folders a seed uses by id', () => {
    const m = parse({ ...minimal, folders: [extensions], seed: [{ path: 's.json', json: { ext: '{folder:extensions}' } }] })
    assert.equal(m.folders?.[0].id, 'extensions')
    assert.equal(parse({ ...minimal, folders: [{ id: 'presets', label: 'Presets', own: '{shared}/presets', use: 'own' }] }).folders?.length, 1)
  })

  it('refuses a folder a seed uses without declaring it', () => {
    invalid({ ...minimal, seed: [{ path: 's.json', json: '{folder:extensions}' }] }, /\{folder:extensions\} is not one of the manifest's "folders"/)
  })

  it('needs an id, a label, paths starting in folders it knows, and which one to use', () => {
    invalid({ ...minimal, folders: 'extensions' }, /"folders" must be a list/)
    invalid({ ...minimal, folders: [{ ...extensions, id: 'my-ext' }] }, /its own "id"/)
    invalid({ ...minimal, folders: [extensions, extensions] }, /its own "id"/)
    invalid({ ...minimal, folders: [{ ...extensions, label: ' ' }] }, /needs a "label"/)
    for (const path of ['C:\\Users\\x', '{documents}/App', '{data}/ext', '{shared}/../..', '{shared}/{venv}']) {
      invalid({ ...minimal, folders: [{ ...extensions, own: path }] }, /"own" must start with \{shared\}, \{short\}/)
    }
    invalid({ ...minimal, folders: [{ ...extensions, installed: { ...extensions.installed, file: '/etc/passwd' } }] }, /"installed.file" must start/)
    invalid({ ...minimal, folders: [{ ...extensions, installed: { ...extensions.installed, usual: 'D:\\App' } }] }, /"installed.usual" must start/)
    invalid({ ...minimal, folders: [{ ...extensions, installed: { ...extensions.installed, key: '' } }] }, /"installed.key"/)
    invalid({ ...minimal, folders: [{ ...extensions, use: 'both' }] }, /"use" must be "own"/)
    invalid({ ...minimal, folders: [{ id: 'x', label: 'X', own: '{shared}/x', use: 'installed' }] }, /"installed" with an "installed" folder/)
  })

  it('shows where each folder will be before approval, and that the tester can switch', () => {
    const m = parse({ ...minimal, folders: [extensions, { ...extensions, id: 'workflows', label: 'Workflows', own: '{shared}/workflows', use: 'own' }] })
    assert.deepEqual(approvalOf({ id: 'o-r', name: 'R', addedAt: '' }, m, { owner: 'o', repo: 'r', ref: 'main' }).settings, [
      "folder \"Extensions\": the installed application's (extensionsDir in {appData}/App/settings.json, else {documents}/App/extensions), else TryMyDev's {short}/ext — you can switch",
      "folder \"Workflows\": TryMyDev's {shared}/workflows, or the installed application's (extensionsDir in {appData}/App/settings.json, else {documents}/App/extensions) — you can switch"
    ])
  })
})

describe('manifestHash', () => {
  it('ignores what does not change what runs', () => {
    const a = parse(minimal)
    const renamed: Manifest = { ...a, name: 'Renamed', repo: 'o/r', source: 'provided', cacheKeys: { node: ['x'] } }
    assert.equal(manifestHash(renamed), manifestHash(a))
  })

  it('changes with anything that runs or is set up', () => {
    const base = manifestHash(parse(minimal))
    for (const change of [
      { install: [{ run: 'npm ci' }] },
      { build: [{ run: 'npm run build' }] },
      { start: { mode: 'web', run: 'npm start' } },
      { share: [{ path: 'models' }] },
      { isolate: [{ env: 'HOME', dir: 'home' }] },
      { env: { A: '1' } },
      { runtime: { node: '20' } },
      { seed: [{ path: 'settings.json', json: { home: '{data}' } }] },
      { folders: [{ id: 'ext', label: 'Extensions', own: '{shared}/ext', use: 'own' }] }
    ]) {
      assert.notEqual(manifestHash(parse({ ...minimal, ...change })), base, JSON.stringify(change))
    }
  })
})

describe('approvalOf', () => {
  const app: App = { id: 'o-r', name: 'R', addedAt: '' }

  it('shows every command with its directory, every setting and every download', () => {
    const m = parse({
      ...minimal,
      install: [{ run: 'pip install -r requirements.txt', cwd: 'api' }],
      share: [{ path: 'models', env: 'MODELS' }],
      isolate: [{ env: 'APP_HOME', dir: 'home' }],
      env: { MODE: 'test' }
    })
    const approval = approvalOf(app, m, { owner: 'fork', repo: 'r', ref: 'main' })

    assert.deepEqual(approval.commands, ['pip install -r requirements.txt    (in api)', 'npm run dev'])
    assert.deepEqual(approval.settings, [
      'shared by every branch: models (MODELS)',
      'separate per branch: APP_HOME → home',
      'environment: MODE=test'
    ])
    assert.equal(approval.repo, 'fork/r')
    assert.equal(approval.manifestHash, manifestHash(m))
    assert.equal(approval.downloads.length, 3)
    assert.match(approval.downloads.join('\n'), /Node\.js[\s\S]*Python[\s\S]*Sources of fork\/r/)
  })

  it('describes an Electron start in words', () => {
    assert.deepEqual(commandsOf(parse({ name: 'E', start: { mode: 'electron' } })), ['launch the Electron application'])
  })
})

describe('resolveManifest', () => {
  const dirs: string[] = []
  after(() => cleanup(...dirs))

  const checkout = (files: Record<string, string>): string => {
    const dir = tempDir()
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    return dir
  }
  const app = (extra: Partial<App> = {}): App => ({ id: 'app', name: 'App', addedAt: '', ...extra })
  const src = { owner: 'o', repo: 'r', ref: 'main' }
  const pkg = JSON.stringify({ name: 'detected-app', scripts: { dev: 'vite' } })

  it('prefers the manifest committed in the repository', () => {
    const dir = checkout({
      'trymydev.json': JSON.stringify({ name: 'From repo', start: { mode: 'command', run: 'x' } }),
      'package.json': pkg
    })
    const m = resolveManifest(dir, app({ manifest: parse(minimal), repo: 'lightningpixel/modly' }), src)
    assert.equal(m.name, 'From repo')
    assert.equal(m.source, 'repository')
  })

  it('reports a broken repository manifest instead of guessing', () => {
    const dir = checkout({ 'trymydev.json': '{ "name": ', 'package.json': pkg })
    assert.throws(() => resolveManifest(dir, app(), src), /trymydev\.json of the repository is not valid JSON/)
  })

  it('then takes the manifest handed over by the developer', () => {
    const m = resolveManifest(checkout({ 'package.json': pkg }), app({ manifest: parse(minimal) }), src)
    assert.equal(m.name, 'App')
    assert.equal(m.source, 'provided')
  })

  it('then a built-in profile, found through the upstream even for a fork', () => {
    const m = resolveManifest(checkout({ 'package.json': pkg }), app({ repo: 'lightningpixel/modly' }), {
      owner: 'someone',
      repo: 'modly-fork',
      ref: 'fix'
    })
    assert.equal(m.name, 'Modly')
    assert.equal(m.source, 'builtin')
  })

  it('recognises ComfyUI in its current home', () => {
    const dir = checkout({ 'requirements.txt': 'torch', 'main.py': '' })
    const m = resolveManifest(dir, app({ repo: 'Comfy-Org/ComfyUI' }), { owner: 'Comfy-Org', repo: 'ComfyUI', ref: 'master' })
    assert.equal(m.source, 'builtin')
    assert.match(m.install?.[0]?.run ?? '', /download\.pytorch\.org/)
  })

  it('falls back to detection', () => {
    const m = resolveManifest(checkout({ 'package.json': pkg, 'package-lock.json': '{}' }), app(), src)
    assert.equal(m.source, 'detected')
    assert.equal(m.name, 'detected-app')
  })
})
