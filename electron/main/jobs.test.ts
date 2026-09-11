import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { uptime } from 'node:os'
import { basename } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { reattach } from './jobs'
import { registryPath } from './paths'
import { patchState, readState } from './provision'
import { isRunning, stop } from './runner'
import { cleanup, until, useUserData } from './testing'

let data: string

before(() => {
  data = useUserData()
  writeJson(registryPath(), {
    apps: [{ id: 'app', name: 'App', addedAt: '' }],
    branches: ['alive', 'stale', 'reused', 'rebooted', 'restarted'].map((ref) => ({
      key: `${ref}-00000000`,
      appId: 'app',
      owner: 'o',
      repo: 'r',
      ref,
      addedAt: ''
    }))
  })
})
after(() => cleanup(data))

describe('reattach', () => {
  it('takes back what still runs, and forgets PIDs that are gone or now belong to another program', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    await until(() => child.pid !== undefined)
    const image = basename(process.execPath).toLowerCase()
    patchState('app', 'alive-00000000', { running: { pid: child.pid!, image, startedAt: Date.now() } })
    patchState('app', 'stale-00000000', { running: { pid: 999_999, image } })
    patchState('app', 'reused-00000000', { running: { pid: child.pid!, image: 'modly.exe' } })
    // Same PID, same executable — but launched before the machine last started.
    patchState('app', 'rebooted-00000000', { running: { pid: child.pid!, image, startedAt: Date.now() - (uptime() + 60) * 1000 } })
    // Same PID, same executable, since the boot — but not at the time this process started.
    patchState('app', 'restarted-00000000', {
      running: { pid: child.pid!, image, startedAt: Date.now() - 600_000 }
    })

    const updates: string[] = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: { key: string }) => updates.push(payload.key) }
    }
    await reattach(() => win as never)

    assert.equal(isRunning('alive-00000000'), true)
    assert.equal(isRunning('stale-00000000'), false)
    assert.equal(readState('app', 'stale-00000000').running, undefined)
    assert.equal(isRunning('reused-00000000'), false)
    assert.equal(readState('app', 'reused-00000000').running, undefined)
    assert.equal(isRunning('rebooted-00000000'), false, 'a PID from before the boot belongs to someone else')
    assert.equal(readState('app', 'rebooted-00000000').running, undefined)
    assert.equal(isRunning('restarted-00000000'), false, 'a PID whose process started at another time belongs to someone else')

    stop('alive-00000000')
    await until(() => updates.includes('alive-00000000'), 10_000)
    assert.equal(isRunning('alive-00000000'), false)
    assert.equal(readState('app', 'alive-00000000').running, undefined)
  })
})
