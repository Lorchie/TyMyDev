import assert from 'node:assert/strict'
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BranchLog } from './logger'
import { cacheDir, pythonsDir } from './paths'
import {
  buildEnv,
  capture,
  killTree,
  processImage,
  processStartTime,
  run,
  splitCommand,
  startProcess,
  type RunContext
} from './proc'
import { ensureShims } from './runtimes/shim'
import { cleanup, isAlive, tempDir, until, useUserData } from './testing'

describe('splitCommand', () => {
  it('splits on spaces and collapses repeated ones', () => {
    assert.deepEqual(splitCommand('  npm   run  build '), ['npm', 'run', 'build'])
  })

  it('keeps quoted spaces and strips the quotes', () => {
    assert.deepEqual(splitCommand(`uv venv "C:\\Program Files\\venv" --python 'a b'`), [
      'uv',
      'venv',
      'C:\\Program Files\\venv',
      '--python',
      'a b'
    ])
  })

  it('keeps one kind of quote inside the other', () => {
    assert.deepEqual(splitCommand(`node -p "require('electron')"`), ['node', '-p', "require('electron')"])
  })

  it('passes shell syntax through as plain arguments', () => {
    assert.deepEqual(splitCommand('echo a && rm -rf / | x'), ['echo', 'a', '&&', 'rm', '-rf', '/', '|', 'x'])
  })

  it('rejects an unbalanced quote', () => {
    assert.throws(() => splitCommand('node -e "oops'), /Unbalanced quote/)
  })
})

describe('buildEnv', () => {
  it('puts the toolchain first on PATH, lets extra variables win, never runs Electron as Node', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const env = buildEnv({
        toolchain: { pathDirs: ['/first', '/second'], env: { SHARED: 'manifest', ONLY: 'manifest' } },
        cwd: '.',
        log: undefined as never,
        extraEnv: { SHARED: 'isolate' }
      })
      assert.ok(env.PATH?.startsWith(`/first${delimiter}/second${delimiter}`))
      assert.equal(env.SHARED, 'isolate')
      assert.equal(env.ONLY, 'manifest')
      assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
      assert.equal(env.Path, undefined)
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE
    }
  })

  it('keeps downloads in the store and ignores an environment the tester activated', () => {
    process.env.VIRTUAL_ENV = 'C:\\somewhere\\.venv'
    try {
      const env = buildEnv({ toolchain: { pathDirs: [] }, cwd: '.', log: undefined as never })
      assert.equal(env.UV_CACHE_DIR, cacheDir('uv'))
      assert.equal(env.PIP_CACHE_DIR, cacheDir('pip'))
      assert.equal(env.npm_config_cache, cacheDir('npm'))
      assert.equal(env.electron_config_cache, cacheDir('electron'))
      assert.equal(env.UV_PYTHON_INSTALL_DIR, pythonsDir())
      assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed')
      assert.equal(env.VIRTUAL_ENV, undefined)
    } finally {
      delete process.env.VIRTUAL_ENV
    }
  })

  it('lets a manifest override a cache location', () => {
    const env = buildEnv({ toolchain: { pathDirs: [], env: { UV_CACHE_DIR: 'D:\\uv' } }, cwd: '.', log: undefined as never })
    assert.equal(env.UV_CACHE_DIR, 'D:\\uv')
  })

  it("leaves out the tester's own tool settings, which would make installs differ between machines", () => {
    const settings = {
      NODE_OPTIONS: '--require C:\\hook.js',
      NODE_ENV: 'production',
      npm_config_ignore_scripts: 'true',
      NPM_CONFIG_OMIT: 'dev',
      PYTHONPATH: 'C:\\lib',
      PYTHONHOME: 'C:\\Python39',
      PIP_USER: '1',
      UV_NO_MANAGED_PYTHON: '1',
      CONDA_DEFAULT_ENV: 'base',
      ELECTRON_MIRROR: 'https://mirror.example/electron/',
      npm_config_registry: 'https://registry.example/'
    }
    Object.assign(process.env, settings)
    try {
      const env = buildEnv({ toolchain: { pathDirs: [], env: { NODE_ENV: 'development' } }, cwd: '.', log: undefined as never })
      for (const name of ['NODE_OPTIONS', 'npm_config_ignore_scripts', 'NPM_CONFIG_OMIT', 'PYTHONPATH', 'PYTHONHOME', 'PIP_USER', 'UV_NO_MANAGED_PYTHON', 'CONDA_DEFAULT_ENV']) {
        assert.equal(env[name], undefined, name)
      }
      assert.equal(env.NODE_ENV, 'development', 'set by the manifest')
      assert.equal(env.ELECTRON_MIRROR, 'https://mirror.example/electron/', 'a mirror is how downloads work there')
      assert.equal(env.npm_config_registry, 'https://registry.example/')
      assert.equal(env.PYTHONUTF8, '1')
      assert.equal(env.PYTHONUNBUFFERED, '1')
      assert.equal(env.PYTHONNOUSERSITE, '1')
      assert.equal(env.NODE_USE_SYSTEM_CA, '1')
    } finally {
      for (const name of Object.keys(settings)) delete process.env[name]
    }
  })

  it('hands the system proxy to the tools, unless the tester set one', () => {
    const saved = Object.fromEntries(
      Object.keys(process.env).filter((k) => /^(https?|all|no)_proxy$/i.test(k)).map((k) => [k, process.env[k]])
    )
    for (const name of Object.keys(saved)) delete process.env[name]
    try {
      const proxied = buildEnv({ toolchain: { pathDirs: [], proxy: 'http://proxy.corp:8080' }, cwd: '.', log: undefined as never })
      assert.equal(proxied.HTTPS_PROXY, 'http://proxy.corp:8080')
      assert.equal(proxied.HTTP_PROXY, 'http://proxy.corp:8080')
      assert.equal(proxied.NO_PROXY, 'localhost,127.0.0.1,::1')
      assert.equal(proxied.ELECTRON_GET_USE_PROXY, '1')

      process.env.HTTPS_PROXY = 'http://mine:3128'
      const own = buildEnv({ toolchain: { pathDirs: [], proxy: 'http://proxy.corp:8080' }, cwd: '.', log: undefined as never })
      assert.equal(own.HTTPS_PROXY, 'http://mine:3128')
      assert.equal(own.HTTP_PROXY, undefined)

      const direct = buildEnv({ toolchain: { pathDirs: [] }, cwd: '.', log: undefined as never })
      assert.equal(direct.ELECTRON_GET_USE_PROXY, undefined)
    } finally {
      delete process.env.HTTPS_PROXY
      Object.assign(process.env, saved)
    }
  })
})

describe('what reaches an application', () => {
  let data: string
  let work: string

  before(() => {
    data = useUserData()
    work = tempDir()
  })
  after(() => cleanup(work, data))

  it("keeps the tester's credentials from it, unless told to pass one", () => {
    const variables = {
      GITHUB_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      DB_PASSWORD: 'secret',
      GITLAB_PAT: 'secret',
      SMTP_PASS: 'secret',
      SENTRY_DSN: 'secret',
      DATABASE_URL: 'postgres://app:secret@db.internal/app',
      https_proxy: 'http://user:pass@proxy.corp:8080',
      HF_TOKEN: 'needed',
      TOKENIZERS_PARALLELISM: 'false',
      HF_HOME: 'D:\\hf',
      SSH_AUTH_SOCK: 'sock',
      TRYMYDEV_PASS_ENV: 'hf_token'
    }
    Object.assign(process.env, variables)
    try {
      const env = buildEnv({
        toolchain: { pathDirs: [], env: { MANIFEST_TOKEN: 'set by the manifest' } },
        cwd: '.',
        log: undefined as never
      })
      for (const name of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GITLAB_PAT', 'SMTP_PASS', 'SENTRY_DSN', 'DATABASE_URL']) {
        assert.equal(env[name], undefined, name)
      }
      assert.equal(env.https_proxy ?? env.HTTPS_PROXY, 'http://user:pass@proxy.corp:8080', 'a proxy keeps its password')
      assert.equal(env.HF_TOKEN, 'needed', 'named in TRYMYDEV_PASS_ENV')
      assert.equal(env.TOKENIZERS_PARALLELISM, 'false')
      assert.equal(env.HF_HOME, 'D:\\hf')
      assert.equal(env.SSH_AUTH_SOCK, 'sock')
      assert.equal(env.MANIFEST_TOKEN, 'set by the manifest')
    } finally {
      for (const name of Object.keys(variables)) delete process.env[name]
    }
  })

  it('passes shell characters to a .cmd file as text, never as commands', { skip: process.platform !== 'win32' }, async () => {
    const tool = join(work, 'echo-args.cmd')
    writeFileSync(tool, '@echo args: %*\r\n')
    const ctx: RunContext = { toolchain: { pathDirs: [] }, cwd: work, log: new BranchLog('app', 'cmd') }

    const out = await capture(`"${tool}" harmless&whoami "two words|more"`, ctx)
    const lines = out.trim().split(/\r?\n/)
    assert.equal(lines.length, 1, out)
    assert.match(lines[0], /harmless&whoami/)
    assert.match(lines[0], /two words\|more/)
    assert.ok(!out.toLowerCase().includes(userInfo().username.toLowerCase()), 'whoami must not have run')
  })
})

describe('running commands', () => {
  let data: string
  let work: string
  let fakeNode: string
  let ctx: RunContext

  const waitForPid = async (file: string): Promise<number> => {
    await until(() => existsSync(file) && readFileSync(file, 'utf-8') !== '')
    return Number(readFileSync(file, 'utf-8'))
  }

  before(() => {
    data = useUserData()
    work = tempDir()
    fakeNode = join(work, process.platform === 'win32' ? 'toolchain-node.exe' : 'toolchain-node')
    try {
      linkSync(process.execPath, fakeNode)
    } catch {
      copyFileSync(process.execPath, fakeNode)
    }
    writeFileSync(
      join(work, 'child.js'),
      `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)`
    )
    writeFileSync(
      join(work, 'parent.js'),
      `require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'child.js'), process.argv[2]], { stdio: 'ignore', windowsHide: true })
setInterval(() => {}, 1000)`
    )
    ctx = {
      toolchain: { pathDirs: [], node: { id: 'test', bin: fakeNode, dir: dirname(fakeNode) } },
      cwd: work,
      log: new BranchLog('app', 'proc')
    }
  })

  after(() => cleanup(work, data))

  it('maps node onto the runtime of the toolchain, not the one on PATH', async () => {
    assert.equal((await capture('node -p process.execPath', ctx)).trim(), fakeNode)
  })

  it('runs npm through the npm shipped with TryMyDev', async () => {
    assert.match((await capture('npm --version', ctx)).trim(), /^\d+\.\d+\.\d+$/)
  })

  it('reports the exit code and the log tail of a failing command', async () => {
    await assert.rejects(
      run(`node -e "console.log('before failing'); process.exit(3)"`, ctx),
      /exit code 3[\s\S]*before failing/
    )
  })

  it('finds a .cmd tool on the system PATH, which spawn alone cannot', { skip: process.platform !== 'win32' }, async () => {
    const bin = tempDir()
    writeFileSync(join(bin, 'tmd-hello.cmd'), '@echo hello from cmd\r\n')
    const previous = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${previous}`
    try {
      assert.equal((await capture('tmd-hello', ctx)).trim(), 'hello from cmd')
    } finally {
      process.env.PATH = previous
      await cleanup(bin)
    }
  })

  it('finds an executable on the system PATH', { skip: process.platform === 'win32' }, async () => {
    const bin = tempDir()
    writeFileSync(join(bin, 'tmd-hello'), '#!/bin/sh\necho hello from sh\n')
    chmodSync(join(bin, 'tmd-hello'), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${previous}`
    try {
      assert.equal((await capture('tmd-hello', ctx)).trim(), 'hello from sh')
    } finally {
      process.env.PATH = previous
      await cleanup(bin)
    }
  })

  it('kills a process together with the processes it started', async () => {
    const pidFile = join(work, 'killed.pid')
    const parent = startProcess(`node parent.js "${pidFile}"`, ctx)
    const grandchild = await waitForPid(pidFile)
    assert.ok(isAlive(grandchild))

    const closed = new Promise((resolve) => parent.once('close', resolve))
    killTree(parent)
    await closed
    await until(() => !isAlive(grandchild))
  })

  it('kills a process tree by PID alone, for an application found again after a restart', async () => {
    const pidFile = join(work, 'by-pid.pid')
    const parent = startProcess(`node parent.js "${pidFile}"`, ctx)
    const grandchild = await waitForPid(pidFile)

    const closed = new Promise((resolve) => parent.once('close', resolve))
    killTree(parent.pid!)
    await closed
    await until(() => !isAlive(grandchild))
  })

  it('takes the whole process tree down when a job is cancelled', async () => {
    const pidFile = join(work, 'cancelled.pid')
    const controller = new AbortController()
    const running = run(`node parent.js "${pidFile}"`, { ...ctx, signal: controller.signal })
    const grandchild = await waitForPid(pidFile)

    controller.abort()
    await assert.rejects(running, /Command failed/)
    await until(() => !isAlive(grandchild))
  })

  it('names the executable behind a PID, and nothing for a PID no one holds', async () => {
    const child = startProcess('node -e "setInterval(() => {}, 1000)"', ctx)
    await until(() => child.pid !== undefined)
    try {
      assert.equal(await processImage(child.pid!), basename(fakeNode).toLowerCase())
    } finally {
      const closed = new Promise((resolve) => child.once('close', resolve))
      killTree(child)
      await closed
    }
    assert.equal(await processImage(child.pid!), undefined)
  })

  it('tells when a process started, and nothing for a PID no one holds', async () => {
    const before = Date.now()
    const child = startProcess('node -e "setInterval(() => {}, 1000)"', ctx)
    await until(() => child.pid !== undefined)
    try {
      const started = await processStartTime(child.pid!)
      assert.ok(started !== undefined && Math.abs(started - before) < 30_000, `started at ${started}, launched at ${before}`)
    } finally {
      const closed = new Promise((resolve) => child.once('close', resolve))
      killTree(child)
      await closed
    }
    assert.equal(await processStartTime(999_999), undefined)
  })

  it(
    'reaches the Node of the toolchain from a batch file when its path has accents, in any code page',
    { skip: process.platform !== 'win32' },
    async () => {
      const dir = join(work, 'Jérôme Ünïcode')
      mkdirSync(dir, { recursive: true })
      const node = join(dir, 'node.exe')
      try {
        linkSync(process.execPath, node)
      } catch {
        copyFileSync(process.execPath, node)
      }
      const shims = await ensureShims('accents', node)
      // cmd.exe reads a batch file in the code page of the console — 850 on a French Windows.
      // The one this test runs in is put back afterwards.
      writeFileSync(
        join(work, 'call-node.cmd'),
        '@echo off\r\nfor /f "tokens=2 delims=:." %%a in (\'chcp\') do set before=%%a\r\nchcp 850 >nul\r\n' +
          'call node -p process.execPath\r\nchcp %before% >nul\r\n'
      )
      const out = await capture(`"${join(work, 'call-node.cmd')}"`, {
        toolchain: { pathDirs: [shims, dir], node: { id: 'accents', bin: node, dir } },
        cwd: work,
        log: new BranchLog('app', 'accents')
      })
      assert.equal(out.trim().split(/\r?\n/).pop(), node)
    }
  )

  it('hands a detached process a file instead of a pipe', async () => {
    const file = join(work, 'app.log')
    const fd = openSync(file, 'a')
    const child = startProcess(`node -e "console.log('straight into the file')"`, ctx, fd)
    closeSync(fd)
    await new Promise((resolve) => child.once('close', resolve))
    assert.match(readFileSync(file, 'utf-8'), /straight into the file/)
  })
})
