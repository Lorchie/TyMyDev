import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AgentTarget, connectAgent } from './agent'
import { Journal } from './journal'
import { pipeChannel } from '../main/link'

interface StubDebugger {
  attached: boolean
  sent: Array<{ method: string; params: unknown }>
  answer: (method: string, params: unknown) => unknown
}
interface StubWindow {
  id: number
  title: string
  focusedWindow: boolean
  webContents: { debugger: StubDebugger; throttling: boolean }
  destroy(): void
}

const dir = mkdtempSync(join(tmpdir(), 'tmd-agent-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const log = join(dir, 'logs', '2026-09-23.log')

function setUp(): { target: AgentTarget; window: StubWindow; journal: Journal } {
  const journal = new Journal({ home: 'C:\\Users\\Jerome', hostname: 'DESK-1' })
  const target = new AgentTarget(
    { page: 'overlay.html', preload: 'overlay.js', label: 'Modly · dev', report: { source: 'lightningpixel/modly@dev', log } },
    journal
  )
  const window = new BrowserWindow({ width: 1280, height: 800, title: 'Modly' }) as unknown as StubWindow
  window.focusedWindow = true
  target.add(window as unknown as BrowserWindow, { take: async () => undefined })
  return { target, window, journal }
}

describe('AgentTarget', () => {
  it('lists the windows it was given, and forgets a closed one', async () => {
    const { target, window } = setUp()
    assert.deepEqual(await target.handle({ op: 'windows' }), [{ id: window.id, title: 'Modly', focused: true }])
    window.destroy()
    assert.deepEqual(await target.handle({ op: 'windows' }), [])
    await assert.rejects(target.handle({ op: 'cdp', window: window.id, method: 'DOM.enable' }), /it was closed/)
  })

  it('attaches the debugger once, and keeps a page running behind other windows', async () => {
    const { target, window } = setUp()
    window.webContents.debugger.answer = (method) => (method === 'Page.captureScreenshot' ? { data: 'UE5H' } : {})
    assert.deepEqual(await target.handle({ op: 'cdp', window: window.id, method: 'Page.captureScreenshot' }), { data: 'UE5H' })
    await target.handle({ op: 'cdp', window: window.id, method: 'DOM.enable' })
    assert.equal(window.webContents.debugger.attached, true)
    assert.equal(window.webContents.throttling, false)
    assert.deepEqual(
      window.webContents.debugger.sent.map((s) => s.method),
      ['Page.captureScreenshot', 'DOM.enable']
    )
  })

  it('refuses a command that would run script in the page', async () => {
    const { target, window } = setUp()
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Page.navigate', 'Debugger.enable']) {
      await assert.rejects(target.handle({ op: 'cdp', window: window.id, method }), /is not a command an agent may send/)
    }
    assert.equal(window.webContents.debugger.sent.length, 0)
  })

  it('writes the report beside the branch log, with the description masked', async () => {
    const { target, window, journal } = setUp()
    journal.add('error', 'Console error: failed to load mesh')
    const path = (await target.handle({
      op: 'report',
      window: window.id,
      description: 'Import fails for C:\\Users\\Jerome\\chair.glb',
      screenshot: true
    })) as string
    assert.equal(join(path, '..'), join(dir, 'logs', 'reports'))
    assert.match(path, /bug-report-modly-dev-\d{8}-\d{6}\.zip$/)
    assert.ok(existsSync(path))
    const zip = readFileSync(path).toString('latin1')
    assert.match(zip, /report\.md/)
    assert.match(zip, /screenshot\.png/)
    assert.doesNotMatch(zip, /Jerome/)
  })

  it('refuses an unknown request', async () => {
    await assert.rejects(setUp().target.handle({ op: 'eval' } as never), /Unknown request: eval/)
  })
})

describe('the pipe between TryMyDev and an application', () => {
  it('carries requests to the application and its answers back', async () => {
    const { target, window } = setUp()
    const { info, channel } = pipeChannel()
    try {
      connectAgent(info, target, () => undefined)
      assert.deepEqual(await channel.request({ op: 'windows' }), [{ id: window.id, title: 'Modly', focused: true }])
      await assert.rejects(channel.request({ op: 'cdp', window: window.id, method: 'Runtime.evaluate' }), /not a command an agent may send/)
    } finally {
      channel.close()
    }
  })

  it('disconnects a program that does not know the secret', async () => {
    const { target } = setUp()
    const { info, channel } = pipeChannel()
    const logged: string[] = []
    try {
      connectAgent({ pipe: info.pipe, secret: 'guessed' }, target, (m) => logged.push(m))
      await assert.rejects(
        Promise.race([
          channel.request({ op: 'windows' }),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('still waiting for the real application')), 1500))
        ]),
        /still waiting for the real application/
      )
    } finally {
      channel.close()
    }
  })

  it('fails the waiting requests once the application is gone', async () => {
    const { target } = setUp()
    const { info, channel } = pipeChannel()
    connectAgent(info, target, () => undefined)
    await channel.request({ op: 'journal' })
    channel.close()
    await assert.rejects(channel.request({ op: 'windows' }), /no longer connected/)
  })
})

