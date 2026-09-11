import assert from 'node:assert/strict'
import { clipboard, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { registerIpc } from './ipc'
import { appLogPath, registryPath } from './paths'
import { cleanup, until, useUserData } from './testing'

type Handler = (event: { sender: { id: number }; senderFrame: { url: string } }, ...args: unknown[]) => Promise<unknown>
const handlers = (ipcMain as unknown as { handlers: Map<string, Handler> }).handlers
const HOME = 'file:///C:/Program%20Files/TryMyDev/resources/app.asar/out/renderer/index.html'
const callFrom = (url: string, channel: string, sender: number, ...args: unknown[]): Promise<unknown> =>
  handlers.get(channel)!({ sender: { id: sender }, senderFrame: { url } }, ...args)
const call = (channel: string, sender: number, ...args: unknown[]): Promise<unknown> =>
  callFrom(`${HOME}#storage`, channel, sender, ...args)

let data: string

before(() => {
  data = useUserData()
  writeJson(registryPath(), {
    apps: [
      { id: 'o-r', name: 'r', repo: 'o/r', addedAt: '' },
      { id: 'o-other', name: 'other', repo: 'o/other', addedAt: '' }
    ],
    branches: [{ key: 'main-00000000', appId: 'o-r', owner: 'o', repo: 'r', ref: 'main', addedAt: '' }]
  })
  registerIpc(() => ({ webContents: { id: 7 } }) as never, HOME)
})
after(() => cleanup(data))

describe('IPC', () => {
  it('answers the TryMyDev window', async () => {
    assert.equal(((await call('apps:list', 7)) as unknown[]).length, 2)
  })

  it('refuses a call from any other page, and logs it', async () => {
    await assert.rejects(call('apps:list', 8), /Refused apps:list/)
    await until(() => existsSync(appLogPath()) && readFileSync(appLogPath(), 'utf-8').includes('[ipc] apps:list failed'))
  })

  it('refuses another file loaded in the TryMyDev window, such as one dropped on it', async () => {
    await assert.rejects(callFrom('file:///C:/Users/tester/Downloads/page.html', 'apps:list', 7), /Refused apps:list/)
    await assert.rejects(callFrom('https://example.com/', 'apps:list', 7), /Refused apps:list/)
  })

  it('records an approval only for the application the branch belongs to', async () => {
    await assert.rejects(call('manifest:approve', 7, 'o-other', 'hash', 'main-00000000'), /not a branch of o-other/)
  })

  it('copies through the main process, the window being sandboxed', async () => {
    await call('app:copy', 7, 'the report')
    assert.equal((clipboard as unknown as { text: string }).text, 'the report')
  })

  it('opens only web addresses in the browser', async () => {
    const opened = (await import('electron')).shell as unknown as { opened: string[] }
    await call('shell:openExternal', 7, 'file:///C:/Windows/System32/calc.exe')
    await call('shell:openExternal', 7, 'https://github.com/Comfy-Org/ComfyUI')
    assert.deepEqual(opened.opened, ['https://github.com/Comfy-Org/ComfyUI'])
  })
})
