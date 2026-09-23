import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { Driver } from '../electron/main/drive'
import { pipeChannel, type Channel } from '../electron/main/link'

// Starts a minimal Electron application the way TryMyDev starts a tested one with agent access
// on — `electron -r inject.js <app>`, the pipe's path and secret in its environment — and drives
// it as an agent does: snapshot, click, type, keys, screenshot, journal and report, through the
// real pipe and the real DevTools protocol. `npm run test:e2e` builds first.

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const root = fileURLToPath(new URL('..', import.meta.url))
const built = process.env.TRYMYDEV_E2E_OVERLAY_ROOT ?? root

let dir: string
let app: ChildProcess
let channel: Channel
let driver: Driver

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trymydev-agent-e2e-'))
  const fixture = join(dir, 'fixture')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', main: 'main.js' }))
  writeFileSync(
    join(fixture, 'main.js'),
    `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 900, height: 700, show: false, title: 'Fixture' })
  window.loadFile(require('path').join(__dirname, 'index.html'))
  window.once('ready-to-show', () => window.showInactive())
})
app.on('window-all-closed', () => app.quit())`
  )
  writeFileSync(
    join(fixture, 'index.html'),
    `<!doctype html><title>Fixture</title>
<h1>Mesh tools</h1>
<button id="export" aria-label="Export mesh">Export</button>
<label>Your name <input id="name"></label>
<label>Password <input id="secret" type="password"></label>
<p id="status">Idle</p>
<script>
const status = document.getElementById('status')
document.getElementById('export').addEventListener('click', () => {
  status.textContent = 'Exported'
  console.error('Export failed: token=abc123')
})
document.getElementById('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') status.textContent = 'Hello ' + e.target.value
})
</script>`
  )
  const log = join(dir, 'logs', 'branch.log')
  mkdirSync(join(dir, 'logs'))
  writeFileSync(log, 'server ready\n')

  const link = pipeChannel()
  channel = link.channel
  driver = new Driver(channel)
  const overlay = {
    page: join(built, 'out', 'renderer', 'overlay.html'),
    preload: join(built, 'out', 'preload', 'overlay.js'),
    label: 'Fixture · main',
    report: { source: 'owner/fixture · main', log }
  }
  app = spawn(electron, ['-r', join(built, 'out', 'main', 'inject.js'), fixture, `--user-data-dir=${join(dir, 'data')}`], {
    cwd: fixture,
    stdio: 'ignore',
    env: { ...process.env, TRYMYDEV_OVERLAY: JSON.stringify(overlay), TRYMYDEV_AGENT: JSON.stringify(link.info) }
  })
  await driver.waitFor('Mesh tools', 30)
})

after(async () => {
  channel?.close()
  if (app?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    else app.kill()
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const refOf = (snapshot: string, line: RegExp): string => {
  const ref = snapshot.split('\n').find((l) => line.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
  assert.ok(ref, `no element matching ${line} in:\n${snapshot}`)
  return ref
}

describe('an agent driving an Electron application', () => {
  it('reads the application window, never the overlay', async () => {
    const windows = await driver.windows()
    assert.equal(windows.length, 1)
    const { text, title } = await driver.snapshot()
    assert.equal(title, 'Fixture')
    assert.match(text, /heading "Mesh tools"/)
    assert.match(text, /button "Export mesh" \[ref=e\d+\]/)
    assert.match(text, /textbox "Your name"/)
    assert.doesNotMatch(text, /TryMyDev tools|Report bug/)
  })

  it('clicks as a person does: the page reacts, the journal records the click and the error', async () => {
    const { text } = await driver.snapshot()
    await driver.click(refOf(text, /button "Export mesh"/))
    assert.match((await driver.snapshot()).text, /text: "Exported"/)
    const journal = await driver.journal()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const later = await driver.journal()
    assert.ok(later.timeline.some((e) => e.kind === 'action' && /Clicked button.* "Export mesh"/.test(e.text)), JSON.stringify(later.timeline))
    assert.ok([...journal.errors, ...later.errors].some((e) => /Export failed/.test(e.text) && !/abc123/.test(e.text)))
  })

  it('types into a field and presses Enter, and never records what was typed', async () => {
    const { text } = await driver.snapshot()
    await driver.type(refOf(text, /textbox "Your name"/), 'Claude tester', false)
    await driver.press('Enter')
    assert.match((await driver.snapshot()).text, /Hello Claude tester/)
    await driver.type(refOf(text, /textbox "Password"/), 'hunter2', false)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const journal = JSON.stringify(await driver.journal())
    assert.doesNotMatch(journal, /Claude tester|hunter2/)
  })

  it('takes a screenshot of the window', async () => {
    const { png } = await driver.screenshot()
    assert.equal(Buffer.from(png, 'base64').subarray(1, 4).toString(), 'PNG')
  })

  it('writes a report beside the branch log', async () => {
    const path = await driver.report('Export shows an error in the console', true)
    assert.equal(join(path, '..'), join(dir, 'logs', 'reports'))
    assert.ok(existsSync(path))
    const zip = readFileSync(path).toString('latin1')
    assert.match(zip, /report\.md/)
    assert.match(zip, /screenshot\.png/)
    assert.match(zip, /logs\.txt/)
  })
})
