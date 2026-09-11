import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BranchLog } from './logger'
import { appShared, branchDataDir, checkoutDir, shortDir, shortOwnerPath } from './paths'
import type { Toolchain } from './proc'
import { adopt, expectedElectronMajor, isRunning, launch, needsOwnElectron, stop, type LaunchResult } from './runner'
import { setPreference } from './settings'
import { cleanup, isAlive, until, useUserData } from './testing'
import type { App, Branch, Manifest } from './types'

interface StubWindow {
  url?: string
  destroy(): void
}
const windows = (BrowserWindow as unknown as { opened: StubWindow[] }).opened

const app: App = { id: 'app', name: 'App', addedAt: '' }
const toolchain: Toolchain = {
  pathDirs: [],
  node: { id: 'test', bin: process.execPath, dir: dirname(process.execPath) }
}
const server = `const http = require('http')
const port = Number(process.argv[2])
http.createServer((req, res) => res.end('served')).listen(port, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:' + port))`

let data: string
let count = 0
let ipv6 = false

before(async () => {
  data = useUserData()
  const probe = createServer()
  ipv6 = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '::1', () => probe.close(() => resolve(true)))
  })
})
after(() => cleanup(data))

function branch(files: Record<string, string> = {}): Branch {
  const ref = `b${++count}`
  const b: Branch = { key: `${ref}-00000000`, appId: app.id, owner: 'o', repo: 'r', ref, addedAt: '' }
  const dir = checkoutDir(app.id, b.key)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return b
}

interface Started extends LaunchResult {
  exit: () => number | null | undefined
  log: BranchLog
}

async function start(b: Branch, manifest: Manifest, signal = new AbortController().signal): Promise<Started> {
  let code: number | null | undefined
  const log = new BranchLog(app.id, b.key)
  const result = await launch(app, b, manifest, {}, toolchain, log, signal, (c) => {
    code = c
  })
  return { ...result, exit: () => code, log }
}

describe('expectedElectronMajor', () => {
  /** A project folder holding only this package.json, or none at all. */
  const project = (name: string, pkg?: string): string => {
    const dir = join(data, 'projects', name)
    mkdirSync(dir, { recursive: true })
    if (pkg !== undefined) writeFileSync(join(dir, 'package.json'), pkg)
    return dir
  }

  it('reads the major from devDependencies or dependencies', () => {
    const dev = project('dev', JSON.stringify({ devDependencies: { electron: '^42.4.1' } }))
    const prod = project('prod', JSON.stringify({ dependencies: { electron: '33.0.0' } }))
    assert.equal(expectedElectronMajor(dev), '42')
    assert.equal(expectedElectronMajor(prod), '33')
  })

  it('knows nothing without package.json, without Electron or with broken JSON', () => {
    for (const dir of [project('empty'), project('plain', '{}'), project('broken', '{ nope')]) {
      assert.equal(expectedElectronMajor(dir), undefined)
    }
  })
})

describe('needsOwnElectron', () => {
  before(() => {
    Object.defineProperty(process.versions, 'electron', { value: '42.4.1', configurable: true })
  })

  it('reuses our Electron for the same major, and only then', () => {
    assert.equal(needsOwnElectron('42'), false)
    assert.equal(needsOwnElectron(undefined), false)
    assert.equal(needsOwnElectron('33'), true)
  })

  it('always brings the branch its own once TryMyDev is packaged', () => {
    process.env.TRYMYDEV_PACKAGED = '1'
    try {
      assert.equal(needsOwnElectron('42'), true)
    } finally {
      delete process.env.TRYMYDEV_PACKAGED
    }
  })
})

describe('launch', () => {
  it('serves a web application on a free port, and stopping it is not a crash', async () => {
    const b = branch({ 'server.js': server })
    const run = await start(b, { name: 'Web', start: { mode: 'web', run: 'node server.js {port}', port: 4600 } })

    assert.match(run.url ?? '', /^http:\/\/127\.0\.0\.1:46\d\d$/)
    assert.equal(run.detached, undefined, 'a server ends with TryMyDev')
    assert.equal(await (await fetch(run.url!)).text(), 'served')
    const window = windows.at(-1) as unknown as {
      url: string
      options: { webPreferences: { partition: string; sandbox: boolean } }
      contentView: { children: { webContents: { ipc: { handlers: Record<string, () => unknown> } } }[] }
    }
    assert.equal(window.url, run.url)
    assert.equal(window.options.webPreferences.partition, `persist:branch-${b.key}`)
    assert.equal(window.options.webPreferences.sandbox, true)
    assert.match((window.options as { icon?: string }).icon ?? '', /resources[\\/]icon\.(ico|png)$/)
    const overlay = window.contentView.children.at(-1)
    const info = (await overlay?.webContents.ipc.handlers['overlay:info']()) as { label: string } | undefined
    assert.equal(isRunning(b.key), true)

    stop(b.key)
    assert.equal(info?.label, `Web · ${b.ref}`)
    await until(() => run.exit() !== undefined)
    assert.equal(run.exit(), null)
    assert.equal(isRunning(b.key), false)
    await assert.rejects(fetch(run.url!))
  })

  it('gives two branches of one application two ports', async () => {
    const one = branch({ 'server.js': server })
    const two = branch({ 'server.js': server })
    const manifest: Manifest = { name: 'Web', start: { mode: 'web', run: 'node server.js {port}', port: 4700 } }
    const first = await start(one, manifest)
    const second = await start(two, manifest)
    try {
      assert.notEqual(first.url, second.url)
    } finally {
      stop(one.key)
      stop(two.key)
      await until(() => first.exit() !== undefined && second.exit() !== undefined)
    }
  })

  it('skips a port another program listens on, even on every address', async () => {
    // On Windows a server on every address does not stop another from listening on 127.0.0.1.
    const holder = createServer()
    await new Promise<void>((resolve) => {
      holder.once('error', () => holder.listen(4850, '0.0.0.0', resolve))
      holder.listen(4850, '::', resolve)
    })
    try {
      const b = branch({ 'server.js': server })
      const run = await start(b, { name: 'Web', start: { mode: 'web', run: 'node server.js {port}', port: 4850 } })
      assert.notEqual(run.url, 'http://127.0.0.1:4850')
      stop(b.key)
      await until(() => run.exit() !== undefined)
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })

  it('finds a server listening on ::1 alone', async (t) => {
    if (!ipv6) return t.skip('no IPv6 loopback here')
    const b = branch({ 'v6.js': `require('http').createServer((q, r) => r.end('v6')).listen(4870, '::1')` })
    const run = await start(b, { name: 'V6', start: { mode: 'web', run: 'node v6.js', port: 4870 } })
    assert.equal(run.url, 'http://[::1]:4870')
    stop(b.key)
    await until(() => run.exit() !== undefined)
  })

  it('opens a server announcing every address on loopback', async () => {
    const b = branch({ 'all.js': `console.log('Serving on http://0.0.0.0:4880/'); setInterval(() => {}, 1000)` })
    const run = await start(b, { name: 'All', start: { mode: 'web', run: 'node all.js' } })
    assert.equal(run.url, 'http://127.0.0.1:4880/')
    stop(b.key)
    await until(() => run.exit() !== undefined)
  })

  it('stops the server when the user closes its window', async () => {
    const b = branch({ 'server.js': server })
    const run = await start(b, { name: 'Web', start: { mode: 'web', run: 'node server.js {port}', port: 4750 } })
    windows.at(-1)?.destroy()
    await until(() => run.exit() !== undefined)
    assert.equal(run.exit(), null)
    assert.equal(isRunning(b.key), false)
  })

  it('fails at once when the application dies before serving', async () => {
    const b = branch()
    await assert.rejects(
      start(b, { name: 'Crash', start: { mode: 'web', run: 'node -e "process.exit(1)"', port: 4800 } }),
      /stopped \(code 1\) before serving anything/
    )
    assert.equal(isRunning(b.key), false)
  })

  it('waits for the address a framework prints when there is no port to watch', async () => {
    const b = branch({ 'dev.js': `console.log('  ➜  Local:   http://localhost:5173/'); setInterval(() => {}, 1000)` })
    const run = await start(b, { name: 'Vite', start: { mode: 'web', run: 'node dev.js' } })
    assert.equal(run.url, 'http://localhost:5173/')
    stop(b.key)
    await until(() => run.exit() !== undefined)
  })

  it('can be cancelled while it waits, killing what it started', async () => {
    const b = branch({ 'silent.js': `require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)` })
    const controller = new AbortController()
    const launching = start(b, { name: 'Silent', start: { mode: 'web', run: 'node silent.js' } }, controller.signal)

    const pidFile = join(checkoutDir(app.id, b.key), 'pid')
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8') !== '')
    const pid = Number(readFileSync(pidFile, 'utf-8'))

    controller.abort()
    await assert.rejects(launching, /stopped/)
    await until(() => !isAlive(pid))
  })

  it('runs a command application with its output going straight to the log file', async () => {
    const b = branch()
    const run = await start(b, { name: 'Cmd', start: { mode: 'command', run: `node -e "console.log('hello from the app')"` } })
    await until(() => run.exit() !== undefined)
    assert.equal(run.exit(), 0)
    assert.match(await run.log.fileTail(), /hello from the app/)
  })

  it('tells how to find a detached application again after a restart', async () => {
    const b = branch()
    const run = await start(b, { name: 'Cmd', start: { mode: 'command', run: 'node -e "setInterval(() => {}, 1000)"' } })
    try {
      assert.equal(run.detached?.image, basename(process.execPath).toLowerCase())
      assert.ok(isAlive(run.detached!.pid))
    } finally {
      stop(b.key)
      await until(() => run.exit() !== undefined)
    }
  })

  it('reports the exit code of a crash', async () => {
    const run = await start(branch(), { name: 'Cmd', start: { mode: 'command', run: 'node -e "process.exit(4)"' } })
    await until(() => run.exit() !== undefined)
    assert.equal(run.exit(), 4)
  })

  it('points isolated and shared variables at their folders', async () => {
    const b = branch({ 'env.js': 'console.log(JSON.stringify({ home: process.env.APP_HOME, models: process.env.MODELS }))' })
    const run = await start(b, {
      name: 'Env',
      start: { mode: 'command', run: 'node env.js' },
      isolate: [{ env: 'APP_HOME', dir: 'home' }],
      share: [{ path: 'models', env: 'MODELS' }]
    })
    await until(() => run.exit() !== undefined)

    const line = (await run.log.fileTail()).split('\n').find((l) => l.includes('"home"'))
    const env = JSON.parse(line ?? '{}') as { home?: string; models?: string }
    assert.equal(env.home, join(branchDataDir(app.id, b.key), 'home'))
    assert.ok(existsSync(env.home!))
    assert.equal(env.models, appShared(app.id, 'models'))
  })

  it('refuses to start with a chosen folder that is gone, rather than making it anew, empty', async () => {
    const b = branch()
    const manifest: Manifest = {
      name: 'Folders',
      start: { mode: 'command', run: 'node -e "0"' },
      folders: [{ id: 'extensions', label: 'Extensions', own: '{shared}/extensions', use: 'own' }],
      seed: [{ path: 'settings.json', json: { ext: '{folder:extensions}' }, merge: true }]
    }
    const unplugged = join(data, 'unplugged-drive', 'extensions')
    const log = new BranchLog(app.id, b.key)
    await assert.rejects(
      launch({ ...app, folders: { extensions: unplugged } }, b, manifest, {}, toolchain, log, new AbortController().signal, () => {}),
      /The Extensions folder you chose, .*unplugged-drive.*, is not there/
    )
    assert.equal(isRunning(b.key), false)
  })

  it('places the seeds in the data folder before the application starts', async () => {
    const b = branch({ 'read.js': "console.log('seeded ' + require('fs').readFileSync(process.argv[2], 'utf-8'))" })
    const settings = join(branchDataDir(app.id, b.key), 'settings.json')
    const run = await start(b, {
      name: 'Seeded',
      start: { mode: 'command', run: `node read.js "${settings}"` },
      seed: [{ path: 'settings.json', json: { home: '{data}', ext: '{short}/ext' } }]
    })
    await until(() => run.exit() !== undefined)
    assert.equal(run.exit(), 0)
    assert.match(await run.log.fileTail(), /seeded \{/)
    // The short folder is claimed by the profile and application using it.
    assert.deepEqual(JSON.parse(readFileSync(shortOwnerPath(shortDir(app.id)), 'utf-8')), { root: data, appId: app.id })
  })
})

describe('launch of an Electron application', () => {
  /** Node plays Electron: it preloads `-r` modules before the script, as Electron's default app does. */
  async function launchDesktop(appPath: string): Promise<{ b: Branch; tail: string; logPath: string }> {
    process.env.TRYMYDEV_APP_PATH = appPath
    try {
      const b = branch({ 'index.js': "console.log('application ' + process.argv.slice(2).join(' '))" })
      const log = new BranchLog(app.id, b.key)
      let code: number | null | undefined
      await launch(
        app,
        b,
        { name: 'Desk', start: { mode: 'electron' } },
        { electronBinary: process.execPath },
        { pathDirs: [] },
        log,
        new AbortController().signal,
        (c) => (code = c)
      )
      await until(() => code !== undefined)
      assert.equal(code, 0)
      return { b, tail: await log.fileTail(), logPath: log.path }
    } finally {
      delete process.env.TRYMYDEV_APP_PATH
    }
  }

  it('preloads the overlay before the application, and tells it what to show', async () => {
    const appPath = join(data, 'launcher')
    mkdirSync(join(appPath, 'out', 'main'), { recursive: true })
    writeFileSync(join(appPath, 'out', 'main', 'inject.js'), "console.log('preloaded ' + process.env.TRYMYDEV_OVERLAY)")

    const { b, tail, logPath } = await launchDesktop(appPath)
    const preloaded = tail.split('\n').find((line) => line.startsWith('preloaded '))
    assert.ok(preloaded, tail)
    assert.ok(tail.indexOf('preloaded ') < tail.indexOf('application '))
    assert.deepEqual(JSON.parse(preloaded.slice('preloaded '.length)), {
      page: join(appPath, 'out', 'renderer', 'overlay.html'),
      preload: join(appPath, 'out', 'preload', 'overlay.js'),
      label: `Desk · ${b.ref}`,
      settings: join(data, 'apps', app.id, 'overlay.json'),
      report: { source: `o/r · ${b.ref}`, log: logPath }
    })
    assert.match(tail, /application --user-data-dir=/)
  })

  it('starts the application as it is when the tools overlay is switched off', async () => {
    const appPath = join(data, 'launcher-off')
    mkdirSync(join(appPath, 'out', 'main'), { recursive: true })
    writeFileSync(join(appPath, 'out', 'main', 'inject.js'), "console.log('preloaded ' + process.env.TRYMYDEV_OVERLAY)")
    setPreference('overlay', false)
    try {
      const { tail } = await launchDesktop(appPath)
      assert.ok(!tail.includes('preloaded'), tail)
      assert.match(tail, /tools overlay switched off in Settings/)
      assert.match(tail, /application --user-data-dir=/)
    } finally {
      setPreference('overlay', true)
    }
  })

  it('still starts the application when the overlay is not built', async () => {
    const appPath = join(data, 'unbuilt')
    mkdirSync(appPath, { recursive: true })
    const { tail } = await launchDesktop(appPath)
    assert.match(tail, /no overlay: .*inject\.js is missing/)
    assert.match(tail, /application --user-data-dir=/)
  })
})

describe('adopt', () => {
  it('shows a surviving application as running, stops it, and notices it is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    await until(() => child.pid !== undefined)
    let gone = false
    adopt('adopted-00000000', child.pid!, () => {
      gone = true
    })
    assert.equal(isRunning('adopted-00000000'), true)

    stop('adopted-00000000')
    await until(() => gone, 10_000)
    assert.equal(isRunning('adopted-00000000'), false)
    assert.equal(isAlive(child.pid!), false)
  })
})
