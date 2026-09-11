import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { detectManifest } from './detect'
import { cudaIndex } from './machine'
import { validate } from './manifest'
import { cleanup, tempDir } from './testing'

const dirs: string[] = []
after(() => cleanup(...dirs))

function project(files: Record<string, unknown>): string {
  const dir = tempDir()
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true })
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

const lock = { 'package-lock.json': '{}' }
const CUDA = cudaIndex()

describe('detectManifest — npm', () => {
  it('builds an Electron application with npm, letting install scripts run', () => {
    const m = detectManifest(
      project({
        ...lock,
        'package.json': { name: 'desk', scripts: { build: 'vite build' }, devDependencies: { electron: '^42.0.0' } }
      }),
      'o/r'
    )
    assert.deepEqual(m.install, [{ run: 'npm install --dangerously-allow-all-scripts' }])
    assert.deepEqual(m.build, [{ run: 'npm run build' }])
    assert.deepEqual(m.start, { mode: 'electron' })
    assert.equal(m.name, 'desk')
    assert.equal(m.source, 'detected')
  })

  it('starts a web project with dev, then start, then falls back to its tests', () => {
    const start = (scripts: Record<string, string>): unknown =>
      detectManifest(project({ ...lock, 'package.json': { scripts } }), 'o/r').start
    assert.deepEqual(start({ dev: 'vite', start: 'node .' }), { mode: 'web', run: 'npm run dev' })
    assert.deepEqual(start({ start: 'node .' }), { mode: 'web', run: 'npm start' })
    assert.deepEqual(start({}), { mode: 'command', run: 'npm test' })
  })

  it('builds nothing without a build script, and names the project after its repository', () => {
    const m = detectManifest(project({ ...lock, 'package.json': {} }), 'owner/repo')
    assert.deepEqual(m.build, [])
    assert.equal(m.name, 'owner/repo')
  })

  it('refuses package managers it does not provide, rather than install another tree', () => {
    for (const [file, name] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun']
    ] as const) {
      assert.throws(
        () => detectManifest(project({ 'package.json': {}, [file]: '' }), 'o/r'),
        new RegExp(`uses ${name}, which is not supported`)
      )
    }
  })

  it('uses npm when a package-lock sits next to another lockfile', () => {
    assert.doesNotThrow(() => detectManifest(project({ ...lock, 'yarn.lock': '', 'package.json': {} }), 'o/r'))
  })

  it('passes the engines range to the Node runtime as written', () => {
    const m = detectManifest(project({ ...lock, 'package.json': { engines: { node: '>=18' } } }), 'o/r')
    assert.equal(m.runtime?.node, '>=18')
  })
})

describe('detectManifest — Python', () => {
  it('installs the requirements and serves the entry point', () => {
    const m = detectManifest(project({ 'requirements.txt': 'flask', 'app.py': '' }), 'o/r')
    assert.deepEqual(m.install, [{ run: 'pip install -r requirements.txt' }])
    assert.deepEqual(m.start, { mode: 'web', run: 'python app.py' })
    assert.deepEqual(m.cacheKeys?.python, ['requirements.txt'])
  })

  it('finds requirements in api/ too', () => {
    const m = detectManifest(project({ 'api/requirements.txt': 'fastapi', 'server.py': '' }), 'o/r')
    assert.deepEqual(m.install, [{ run: 'pip install -r api/requirements.txt' }])
    assert.deepEqual(m.cacheKeys?.python, ['api/requirements.txt'])
  })

  it('installs a pyproject.toml project, keyed on uv.lock too', () => {
    const m = detectManifest(
      project({ 'pyproject.toml': '[project]\ndependencies = ["fastapi"]', 'uv.lock': '', 'main.py': '' }),
      'o/r'
    )
    assert.deepEqual(m.install, [{ run: 'pip install -r pyproject.toml' }])
    assert.deepEqual(m.cacheKeys?.python, ['pyproject.toml', 'uv.lock'])
  })

  it('takes torch from the PyTorch index on NVIDIA machines, only the packages listed', () => {
    const m = detectManifest(project({ 'requirements.txt': 'numpy\ntorch>=2.4\ntorchsde\ntorchaudio', 'main.py': '' }), 'o/r')
    assert.deepEqual(m.install, [
      { run: `pip install torch torchaudio --extra-index-url ${CUDA}`, when: { gpu: 'nvidia' } },
      { run: 'pip install -r requirements.txt' }
    ])
  })

  it('finds torch among pyproject dependencies too', () => {
    const m = detectManifest(project({ 'pyproject.toml': 'dependencies = [\n  "torch==2.6",\n  "torchvision",\n]', 'app.py': '' }), 'o/r')
    assert.equal(m.install?.[0]?.run, `pip install torch torchvision --extra-index-url ${CUDA}`)
  })

  it('serves a Django project on a free port', () => {
    const m = detectManifest(project({ 'requirements.txt': 'django', 'manage.py': '' }), 'o/r')
    assert.deepEqual(m.start, { mode: 'web', run: 'python manage.py runserver 127.0.0.1:{port}', port: 8000 })
  })

  it('prefers a Python entry point over npm scripts', () => {
    const m = detectManifest(
      project({ ...lock, 'package.json': { scripts: { dev: 'vite' } }, 'requirements.txt': '', 'main.py': '' }),
      'o/r'
    )
    assert.deepEqual(m.start, { mode: 'web', run: 'python main.py' })
    assert.equal(m.install?.length, 2)
  })

  it('explains a Python project without an entry point it knows', () => {
    assert.throws(() => detectManifest(project({ 'requirements.txt': 'flask' }), 'o/r'), /no entry point TryMyDev recognises/)
  })
})

describe('detectManifest — anything else', () => {
  it('gives up with advice on a project it cannot recognise', () => {
    assert.throws(() => detectManifest(project({ 'README.md': '# hi' }), 'o/r'), /could not be recognised automatically/)
  })

  it('produces manifests that pass validation', () => {
    for (const files of [
      { ...lock, 'package.json': { devDependencies: { electron: '42' } } },
      { ...lock, 'package.json': { scripts: { dev: 'vite' } } },
      { 'requirements.txt': 'torch', 'main.py': '' },
      { 'pyproject.toml': '', 'manage.py': '' }
    ]) {
      const m = detectManifest(project(files), 'o/r')
      assert.doesNotThrow(() => validate(JSON.stringify(m), 'detected'))
    }
  })
})
