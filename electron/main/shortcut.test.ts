import assert from 'node:assert/strict'
import { shell } from 'electron'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createShortcut } from './shortcut'
import { cleanup, useUserData } from './testing'

interface Written {
  path: string
  operation: string
  details: { target: string; args: string; description: string }
}

const written = (shell as unknown as { shortcuts: Written[] }).shortcuts
let data: string

before(() => {
  data = useUserData()
})
after(() => cleanup(data))

describe('createShortcut', { skip: process.platform === 'win32' ? false : 'Windows only' }, () => {
  it('writes a desktop shortcut that starts the branch directly', () => {
    const path = createShortcut(
      { id: 'modly', name: 'Modly', addedAt: '' },
      { key: 'feat-x-00000000', appId: 'modly', owner: 'someone', repo: 'modly', ref: 'feat/x', addedAt: '' }
    )
    const [shortcut] = written

    assert.equal(path, join(data, 'Modly - feat-x.lnk'))
    assert.equal(shortcut.operation, 'create')
    assert.equal(shortcut.details.target, process.execPath)
    assert.match(shortcut.details.args, /^".+" --start=someone\/modly@feat\/x$/, 'unpackaged, the app folder comes first')
  })

  it('starts the packaged application with the branch alone', () => {
    process.env.TRYMYDEV_PACKAGED = '1'
    try {
      createShortcut(
        { id: 'modly', name: 'Modly', addedAt: '' },
        { key: 'dev-00000000', appId: 'modly', owner: 'lightningpixel', repo: 'modly', ref: 'dev', addedAt: '' }
      )
      assert.equal(written.at(-1)?.details.args, '--start=lightningpixel/modly@dev')
    } finally {
      delete process.env.TRYMYDEV_PACKAGED
    }
  })
})
