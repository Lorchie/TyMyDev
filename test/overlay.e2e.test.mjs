import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

// Starts a minimal Electron application the way TryMyDev starts a tested one —
// `electron -r inject.js <app>` — and drives the overlay it gets through the Chrome
// DevTools Protocol. `npm run test:e2e` builds first. The save dialog is native: saving
// is covered by the unit tests.

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = fileURLToPath(new URL('..', import.meta.url))
/**
 * Where the overlay's built files are read from. TRYMYDEV_E2E_OVERLAY_ROOT points at a packaged
 * `resources/app.asar`: a branch's own Electron then reads them inside TryMyDev's archive.
 */
const built = process.env.TRYMYDEV_E2E_OVERLAY_ROOT ?? root
const PORT = 9341

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition')
    await wait(100)
  }
}

/** A DevTools connection to one page. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description)
    return reply.result?.result?.value
  }
  return { send, evaluate, close: () => socket.close() }
}

let dir
let app
let page
let overlay
let log
let settings

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trymydev-overlay-e2e-'))
  const fixture = join(dir, 'fixture')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', main: 'main.js' }))
  writeFileSync(
    join(fixture, 'main.js'),
    `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 900, height: 700, show: false })
  window.loadFile(require('path').join(__dirname, 'index.html'))
  window.once('ready-to-show', () => window.show())
})
app.on('window-all-closed', () => app.quit())`
  )
  writeFileSync(
    join(fixture, 'index.html'),
    `<!doctype html><title>Fixture</title>
<button id="export" aria-label="Export mesh">Export</button>
<input id="secret" type="password">
<input id="name" placeholder="Your name">
<script>
document.getElementById('export').addEventListener('click', () => console.error('Export failed: token=abc123'))
</script>`
  )
  log = join(dir, 'branch.log')
  writeFileSync(log, 'server ready\nconnecting with api_key=xyz789\n')
  settings = join(dir, 'overlay.json')

  const overlayOptions = {
    page: join(built, 'out', 'renderer', 'overlay.html'),
    preload: join(built, 'out', 'preload', 'overlay.js'),
    label: 'Fixture · main',
    settings,
    report: { source: 'owner/fixture · main', commit: '0123456789abcdef', log }
  }
  app = spawn(
    electron,
    [
      '-r',
      join(built, 'out', 'main', 'inject.js'),
      fixture,
      `--user-data-dir=${join(dir, 'data')}`,
      `--remote-debugging-port=${PORT}`,
      // A window hidden behind others stops laying out its pages: sizes would never change.
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    { cwd: fixture, stdio: 'ignore', env: { ...process.env, TRYMYDEV_OVERLAY: JSON.stringify(overlayOptions) } }
  )

  const targets = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const found = { page: list.find((t) => t.url.endsWith('index.html')), overlay: list.find((t) => t.url.endsWith('overlay.html')) }
      return found.page && found.overlay ? found : undefined
    } catch {
      return undefined
    }
  }, 30_000)
  page = await connect(targets.page)
  overlay = await connect(targets.overlay)
  await until(() => overlay.evaluate(`document.querySelector('[data-label]')?.textContent === 'Fixture · main'`))
  await until(() => page.evaluate(`document.readyState === 'complete'`))
})

after(async () => {
  page?.close()
  overlay?.close()
  if (app?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    else app.kill()
  }
  await wait(1500)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

/** A trusted click, as the tester's mouse makes one. */
async function clickOn(selector) {
  const { x, y } = await page.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

describe('overlay in a tested Electron application', () => {
  it('shows its button, and leaves the tested page without any bridge or recorder in reach', async () => {
    assert.equal(await overlay.evaluate('document.body.dataset.view ?? "button"'), 'button')
    assert.equal(await overlay.evaluate('innerWidth'), 52)
    assert.equal(await page.evaluate('typeof window.overlay'), 'undefined')
    assert.equal(await page.evaluate('typeof __tmdTake'), 'undefined')
  })

  it('reports the last actions, the error and the log, masked, and nothing typed', async () => {
    await clickOn('#export')
    await clickOn('#secret')
    await page.send('Input.insertText', { text: 'hunter2' })
    await clickOn('#name')
    await page.send('Input.insertText', { text: 'Jane Doe' })

    const report = await until(async () => {
      const prepared = await overlay.evaluate('window.overlay.report.start()')
      return prepared.markdown.includes('Typed in') ? prepared : undefined
    })
    const md = report.markdown
    assert.match(md, /Clicked button#export "Export mesh"/)
    assert.match(md, /Console error: Export failed: token=\[redacted\]/)
    assert.match(md, /Typed in input\[text\]#name "Your name"/)
    assert.match(md, /- Source: owner\/fixture · main · commit 0123456789ab/)
    assert.match(report.logs, /api_key=\[redacted\]/)
    assert.match(report.screenshot ?? '', /^data:image\/png;base64,/)
    for (const secret of ['hunter2', 'Jane Doe', 'abc123', 'xyz789', '#secret']) {
      assert.ok(!md.includes(secret) && !report.logs.includes(secret), `${secret} stays out of the report`)
    }

    const preview = await overlay.evaluate(`window.overlay.report.preview('Export does nothing, see ghp_abcdefghijklmnopqrstuvwxyz0123456789')`)
    assert.match(preview, /## What happened\n\nExport does nothing, see \[redacted\]\n/)
    await overlay.evaluate('window.overlay.report.close()')
  })

  it('opens its report form on top of the application', async () => {
    await overlay.evaluate(`document.getElementById('toggle').click()`)
    await until(() => overlay.evaluate(`document.body.dataset.view === 'menu'`))
    await overlay.evaluate(`document.querySelector('.tool').click()`)
    await until(() => overlay.evaluate(`document.body.dataset.view === 'report' && !document.getElementById('save').disabled`))
    const size = await until(async () => {
      const current = await overlay.evaluate('({ width: innerWidth, height: innerHeight })')
      return current.width > 400 ? current : undefined
    })
    assert.ok(size.height > 300, JSON.stringify(size))
    assert.match(await overlay.evaluate(`document.getElementById('markdown').textContent`), /# Bug report: Fixture · main/)
    await overlay.evaluate(`document.querySelector('#report footer [data-close]').click()`)
    await until(() => overlay.evaluate('innerWidth === 52'))
  })

  it('moves its button to where it is dropped, and remembers it', async () => {
    const from = await overlay.evaluate('window.overlay.drag()')
    assert.ok(from.x > 400, JSON.stringify(from))
    await until(() => overlay.evaluate('innerWidth > 800'))
    const anchor = await overlay.evaluate('window.overlay.drop(20, 100)')
    assert.equal(anchor.side, 'left')
    await until(() => overlay.evaluate('innerWidth === 52'))
    await until(() => existsSync(settings))
    assert.equal(JSON.parse(readFileSync(settings, 'utf-8')).anchor.side, 'left')
  })
})
