import assert from 'node:assert/strict'
import { clipboard, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { registerIpc } from './ipc'
import { appLogPath, registryPath } from './paths'
import { cleanup, tempDir, until, useUserData } from './testing'

type Handler = (event: { sender: { id: number }; senderFrame: { url: string } }, ...args: unknown[]) => Promise<unknown>
const handlers = (ipcMain as unknown as { handlers: Map<string, Handler> }).handlers
const HOME = 'file:///C:/Program%20Files/TryMyDev/resources/app.asar/out/renderer/index.html'
const callFrom = (url: string, channel: string, sender: number, ...args: unknown[]): Promise<unknown> =>
  handlers.get(channel)!({ sender: { id: sender }, senderFrame: { url } }, ...args)
const call = (channel: string, sender: number, ...args: unknown[]): Promise<unknown> =>
  callFrom(`${HOME}#storage`, channel, sender, ...args)

let data: string
/** Somewhere a tester may choose: not inside TryMyDev's own folders. */
let outside: string

before(() => {
  data = useUserData()
  outside = tempDir('trymydev-chosen-')
  writeJson(registryPath(), {
    apps: [
      { id: 'o-r', name: 'r', repo: 'o/r', addedAt: '' },
      { id: 'o-other', name: 'other', repo: 'o/other', addedAt: '' },
      {
        id: 'o-tool',
        name: 'Tool',
        repo: 'o/tool',
        addedAt: '',
        manifest: {
          name: 'Tool',
          start: { mode: 'electron' },
          folders: [{ id: 'extensions', label: 'Extensions', own: '{shared}/extensions', use: 'own' }]
        }
      },
      {
        id: 'o-flow',
        name: 'Flow',
        repo: 'o/flow',
        addedAt: '',
        manifest: {
          name: 'Flow',
          start: { mode: 'electron' },
          folders: [
            {
              id: 'workflows',
              label: 'Workflows',
              own: '{shared}/workflows',
              installed: { file: '{appData}/Flow/settings.json', key: 'workflowsDir', usual: '{documents}/Flow/workflows' },
              use: 'own'
            }
          ]
        }
      }
    ],
    branches: [{ key: 'main-00000000', appId: 'o-r', owner: 'o', repo: 'r', ref: 'main', addedAt: '' }]
  })
  registerIpc(() => ({ webContents: { id: 7 } }) as never, HOME)
})
after(() => cleanup(data, outside))

describe('IPC', () => {
  it('answers the TryMyDev window', async () => {
    assert.equal(((await call('apps:list', 7)) as unknown[]).length, 4)
  })

  it("lets the tester pick an application's folder through the system's picker, and go back to TryMyDev's", async () => {
    const stubDialog = dialog as unknown as { openPath?: string }
    const ours = [{ id: 'extensions', label: 'Extensions', path: join(data, 'apps', 'o-tool', 'shared', 'extensions'), source: 'own', chosen: false }]
    assert.deepEqual(await call('apps:folders', 7, 'o-tool'), ours)

    stubDialog.openPath = undefined
    assert.deepEqual(await call('apps:chooseFolder', 7, 'o-tool', 'extensions'), ours, 'cancelled')

    stubDialog.openPath = join(outside, 'D', 'extensions')
    assert.deepEqual(await call('apps:chooseFolder', 7, 'o-tool', 'extensions'), [
      { id: 'extensions', label: 'Extensions', path: join(outside, 'D', 'extensions'), source: 'custom', chosen: true }
    ])
    assert.deepEqual(await call('apps:useFolder', 7, 'o-tool', 'extensions', 'own'), ours, 'the manifest choice is stored as none')
    const saved = JSON.parse(readFileSync(registryPath(), 'utf-8')) as { apps: { id: string; folders?: unknown }[] }
    assert.equal(saved.apps.find((a) => a.id === 'o-tool')?.folders, undefined)

    stubDialog.openPath = join(data, 'apps', 'o-tool', 'branches', 'main-00000000')
    await assert.rejects(call('apps:chooseFolder', 7, 'o-tool', 'extensions'), /belongs to TryMyDev/)
    assert.deepEqual(await call('apps:folders', 7, 'o-tool'), ours, 'nothing saved')
    stubDialog.openPath = undefined

    await assert.rejects(call('apps:useFolder', 7, 'o-tool', 'extensions', 'installed'), /Tool is not installed on this computer/)
    await assert.rejects(call('apps:useFolder', 7, 'o-tool', 'extensions', 'C:\\Windows'), /no folder "C:\\Windows"/)
    await assert.rejects(call('apps:chooseFolder', 7, 'o-tool', 'models'), /has no folder models/)
    await assert.rejects(call('apps:useFolder', 7, 'o-r', 'extensions', 'own'), /has no folder extensions/)
    await assert.rejects(call('apps:chooseFolder', 8, 'o-tool', 'extensions'), /Refused apps:chooseFolder/)
  })

  it("switches between TryMyDev's folder and the installed application's, found again in the main process", async () => {
    const installed = join(outside, 'Documents', 'Flow', 'workflows')
    writeJson(join(data, 'Flow', 'settings.json'), { workflowsDir: installed })
    const ours = join(data, 'apps', 'o-flow', 'shared', 'workflows')
    assert.deepEqual(await call('apps:folders', 7, 'o-flow'), [
      { id: 'workflows', label: 'Workflows', path: ours, source: 'own', chosen: false, installed }
    ])
    assert.deepEqual(await call('apps:useFolder', 7, 'o-flow', 'workflows', 'installed'), [
      { id: 'workflows', label: 'Workflows', path: installed, source: 'installed', chosen: true, installed }
    ])
    assert.deepEqual(await call('apps:useFolder', 7, 'o-flow', 'workflows', 'own'), [
      { id: 'workflows', label: 'Workflows', path: ours, source: 'own', chosen: false, installed }
    ])
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

  it('switches a preference, and nothing else', async () => {
    assert.deepEqual(await call('settings:get', 7), { githubToken: false, autoCleanup: true, overlay: true, agent: false })
    assert.deepEqual(await call('settings:setPreference', 7, 'overlay', false), {
      githubToken: false,
      autoCleanup: true,
      overlay: false,
      agent: false
    })
    await assert.rejects(call('settings:setPreference', 7, 'githubToken', true), /Unknown setting/)
    await call('settings:setPreference', 7, 'overlay', true)
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
