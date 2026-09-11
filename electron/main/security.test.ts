import assert from 'node:assert/strict'
import { BrowserWindow, session, shell } from 'electron'
import { after, before, beforeEach, describe, it } from 'node:test'
import { branchSession, confine, forgetBranchSession, openExternalSafely, restrictPermissions } from './security'
import { cleanup, useUserData } from './testing'

interface FakeContents {
  openHandler: (details: { url: string }) => { action: string }
  emit(event: string, ...args: unknown[]): void
}

interface FakeSession {
  cleared: number
  requestHandler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
  checkHandler: (contents: unknown, permission: string) => boolean
}

const opened = (shell as unknown as { opened: string[] }).opened
let data: string

before(() => {
  data = useUserData()
})
after(() => cleanup(data))
beforeEach(() => {
  opened.length = 0
})

describe('openExternalSafely', () => {
  it('sends web addresses to the browser, and nothing that could start a program', () => {
    for (const url of [
      'https://github.com/o/r',
      'http://127.0.0.1:8188/',
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:privacy',
      'javascript:alert(1)',
      'smb://server/share',
      'not a url'
    ]) {
      openExternalSafely(url)
    }
    assert.deepEqual(opened, ['https://github.com/o/r', 'http://127.0.0.1:8188/'])
  })
})

describe('confine', () => {
  const contents = (): FakeContents => new BrowserWindow({}).webContents as unknown as FakeContents

  const navigate = (target: FakeContents, url: string): boolean => {
    let prevented = false
    target.emit('will-navigate', {
      url,
      preventDefault: () => {
        prevented = true
      }
    })
    return prevented
  }

  it('keeps a window on its own origin and hands everything else to the browser, filtered', () => {
    const target = contents()
    confine(target as never, 'http://127.0.0.1:8188/')

    assert.equal(navigate(target, 'http://127.0.0.1:8188/settings'), false)
    assert.equal(navigate(target, 'http://127.0.0.1:3000/'), true, 'another port is another application')
    assert.equal(navigate(target, 'https://example.com/'), true)
    assert.equal(navigate(target, 'file:///C:/Windows/System32/calc.exe'), true)
    assert.deepEqual(target.openHandler({ url: 'https://docs.example.com/' }), { action: 'deny' })
    assert.deepEqual(target.openHandler({ url: 'file:///C:/evil.exe' }), { action: 'deny' })

    assert.deepEqual(opened, ['http://127.0.0.1:3000/', 'https://example.com/', 'https://docs.example.com/'])
  })

  it('keeps the TryMyDev window on its own page, refusing any other local file', () => {
    const target = contents()
    confine(target as never, 'file:///C:/Users/J%C3%A9r%C3%B4me/app/out/renderer/index.html')
    assert.equal(navigate(target, 'file:///C:/Users/J%C3%A9r%C3%B4me/app/out/renderer/index.html#storage'), false)
    assert.equal(navigate(target, 'file:///C:/Users/Jérôme/app/out/renderer/index.html'), false, 'escaped or not')
    assert.equal(navigate(target, 'file:///C:/Users/tester/Downloads/dropped.html'), true)
    assert.equal(navigate(target, 'file:///C:/Users/J%C3%A9r%C3%B4me/app/out/renderer/other.html'), true)
    assert.equal(navigate(target, 'https://example.com/'), true)
  })
})

describe('permissions', () => {
  const ask = (target: FakeSession, permission: string): Promise<boolean> =>
    new Promise((resolve) => target.requestHandler(undefined, permission, resolve))

  it('refuses everything to the TryMyDev window', async () => {
    restrictPermissions(session.defaultSession)
    const target = session.defaultSession as unknown as FakeSession
    for (const permission of ['media', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write']) {
      assert.equal(await ask(target, permission), false, permission)
    }
    assert.equal(target.checkHandler(undefined, 'media'), false)
  })

  it('gives every branch its own session, allowing a tested page only what it needs', async () => {
    const partition = branchSession('dev-12345678')
    assert.equal(partition, 'persist:branch-dev-12345678')
    assert.notEqual(branchSession('main-87654321'), partition)

    const target = session.fromPartition(partition) as unknown as FakeSession
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
      assert.equal(await ask(target, permission), false, permission)
    }
    assert.equal(await ask(target, 'fullscreen'), true)
    assert.equal(await ask(target, 'clipboard-sanitized-write'), true)
    assert.equal(target.checkHandler(undefined, 'fullscreen'), true)
  })

  it('forgets the cookies and storage of a deleted branch', () => {
    forgetBranchSession('dev-12345678')
    assert.equal((session.fromPartition('persist:branch-dev-12345678') as unknown as FakeSession).cleared, 1)
  })
})
