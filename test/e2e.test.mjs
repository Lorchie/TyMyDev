import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

// Drives the built application through the Chrome DevTools Protocol, on a user-data
// folder of its own. `npm run test:e2e` builds first.

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = 9339

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition')
    await wait(100)
  }
}

let data
let app
let socket
let nextId = 0
const pending = new Map()

async function evaluate(expression) {
  const id = ++nextId
  const reply = await new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description)
  return reply.result?.result?.value
}

const click = (selector, text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

before(async () => {
  data = mkdtempSync(join(tmpdir(), 'trymydev-e2e-'))
  writeFileSync(
    join(data, 'registry.json'),
    JSON.stringify({
      apps: [
        { id: 'e2e-keep', name: 'Keep Me', repo: 'trymydev-e2e/keep', addedAt: '' },
        { id: 'e2e-drop', name: 'Drop Me', repo: 'trymydev-e2e/drop', addedAt: '' }
      ],
      branches: []
    })
  )
  mkdirSync(join(data, 'apps', 'e2e-drop', 'branches', 'main-00000000', 'checkout'), { recursive: true })
  writeFileSync(join(data, 'apps', 'e2e-drop', 'branches', 'main-00000000', 'checkout', 'main.js'), 'x')

  // TRYMYDEV_E2E_APP points at a packaged TryMyDev.exe to test the build testers get.
  const packaged = process.env.TRYMYDEV_E2E_APP
  const args = [`--user-data-dir=${data}`, `--remote-debugging-port=${PORT}`]
  app = spawn(packaged ?? electron, packaged ? args : ['.', ...args], { cwd: root, stdio: 'ignore' })

  const page = await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      return targets.find((t) => t.type === 'page' && t.title === 'TryMyDev')
    } catch {
      return undefined
    }
  }, 30_000)

  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  await until(() => evaluate(`document.querySelectorAll('.app-item').length === 2`))
})

after(async () => {
  socket?.close()
  if (app?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    else app.kill()
  }
  await wait(1500)
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

describe('TryMyDev window', () => {
  it('lists the applications with their repository', async () => {
    const items = await evaluate(`[...document.querySelectorAll('.app-item')].map((e) => e.innerText)`)
    assert.ok(items.some((text) => text.includes('Keep Me') && text.includes('trymydev-e2e/keep')), items.join(' | '))
  })

  it('runs its page without Node, with only the bridge the preload exposes', async () => {
    assert.equal(await evaluate('typeof process'), 'undefined')
    assert.equal(await evaluate('typeof require'), 'undefined')
    assert.equal(await evaluate('window.trymydev.platform'), process.platform)
  })

  it('removes an application after confirmation, at once, and its folder soon after', async () => {
    assert.ok(await click('.app-item', 'Drop Me'))
    assert.ok(await click('header button', 'Remove'))
    assert.equal(await until(() => evaluate(`document.querySelector('.dialog h2')?.textContent`)), 'Remove Drop Me')
    assert.ok(await click('.dialog button.primary', 'Remove'))

    await until(() => evaluate(`![...document.querySelectorAll('.app-item')].some((e) => e.textContent.includes('Drop Me'))`), 3_000)
    await until(() => !existsSync(join(data, 'apps', 'e2e-drop')))
  })

  it('reports a failure nothing caught, in a notice and in its log', async () => {
    await evaluate(`setTimeout(() => { Promise.reject(new Error('e2e failure')) }, 0); true`)
    const notice = await until(() => evaluate(`document.querySelector('.toast')?.textContent`))
    assert.match(notice, /e2e failure/)
    await until(() => {
      const log = join(data, 'logs', 'main.log')
      return existsSync(log) && readFileSync(log, 'utf-8').includes('[window] e2e failure')
    })
    await click('.toast button', 'Dismiss')
  })

  it('opens Storage and Settings', async () => {
    assert.ok(await click('aside button', 'Storage'))
    assert.equal(await until(() => evaluate(`document.querySelector('.dialog h2')?.textContent`)), 'Storage')
    await until(() => evaluate(`!document.querySelector('.dialog')?.textContent.includes('Measuring')`))
    assert.ok(await click('.dialog button', 'Close'))

    assert.ok(await click('aside button', 'Settings'))
    assert.equal(await until(() => evaluate(`document.querySelector('.dialog h2')?.textContent`)), 'Settings')
    await until(() => evaluate(`document.querySelector('.dialog')?.textContent.includes('No token saved.')`))
    assert.ok(await click('.dialog button', 'Close'))
  })
})
