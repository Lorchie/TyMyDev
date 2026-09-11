import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { appLog, errorText } from './applog'
import { appLogPath } from './paths'
import { cleanup, until, useUserData } from './testing'

let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))

const logged = (text: string): Promise<void> =>
  until(() => existsSync(appLogPath()) && readFileSync(appLogPath(), 'utf-8').includes(text))

describe('appLog', () => {
  // First in the file: the size is only looked at before the first line.
  it('starts a new file when the log has grown too large, keeping the one before', async () => {
    mkdirSync(dirname(appLogPath()), { recursive: true })
    writeFileSync(appLogPath(), 'x'.repeat(6 * 1024 * 1024))
    appLog('fresh start')
    await logged('fresh start')
    assert.ok(statSync(appLogPath()).size < 1000)
    assert.ok(existsSync(appLogPath().replace(/\.log$/, '.old.log')))
  })

  it('appends timestamped lines in order', async () => {
    appLog('first')
    appLog('second')
    await logged('second')
    assert.match(readFileSync(appLogPath(), 'utf-8'), /\] first\n\[[^\]]+\] second\n$/)
  })

  it('describes an error with its stack, and anything else as text', () => {
    assert.match(errorText(new Error('boom')), /^Error: boom\n\s+at /)
    assert.equal(errorText('plain'), 'plain')
  })
})
