import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BranchLog } from './logger'
import { logsDir } from './paths'
import { cleanup, until, useUserData } from './testing'

const ESC = String.fromCharCode(27)
let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))

const flushed = (log: BranchLog, text: string): Promise<void> =>
  until(() => existsSync(log.path) && readFileSync(log.path, 'utf-8').includes(text))

describe('BranchLog', () => {
  it('keeps the non-empty lines in memory and writes them, timestamped, to its file', async () => {
    const log = new BranchLog('app', 'lines')
    log.write('first\r\n\n   \nsecond\n')
    log.line('third')
    assert.equal(log.getTail(2), 'second\nthird')

    await flushed(log, 'third')
    assert.match(readFileSync(log.path, 'utf-8'), /^\[\d{4}-\d\d-\d\dT[^\]]+\] first\n\[[^\]]+\] second\n/)
  })

  it('drops colour codes from what it keeps, writes and reads back', async () => {
    const log = new BranchLog('app', 'ansi')
    log.write(`${ESC}[32m[INFO]${ESC}[0m ready\n`)
    assert.equal(log.getTail(1), '[INFO] ready')
    await flushed(log, 'ready')
    assert.equal(readFileSync(log.path, 'utf-8').includes(ESC), false)

    appendFileSync(log.path, `${ESC}[31mfrom the application${ESC}[0m\n`)
    assert.equal(await log.fileTail(1), 'from the application')
  })

  it('hands every line to its listener', () => {
    const log = new BranchLog('app', 'listener')
    const seen: string[] = []
    log.onLine((line) => seen.push(line))
    log.write('a\nb')
    assert.deepEqual(seen, ['a', 'b'])
  })

  it('bounds what it keeps in memory', () => {
    const log = new BranchLog('app', 'bounded')
    for (let i = 0; i < 250; i++) log.line(`line ${i}`)
    const tail = log.getTail(1000).split('\n')
    assert.equal(tail.length, 200)
    assert.equal(tail.at(-1), 'line 249')
  })

  it('reads back what an application wrote straight into the file', async () => {
    const log = new BranchLog('app', 'detached')
    log.line('from TryMyDev')
    await flushed(log, 'from TryMyDev')
    appendFileSync(log.path, 'from the application\n')
    assert.match(await log.fileTail(5), /from TryMyDev\nfrom the application$/)
  })

  it('falls back to the memory tail when the file is gone', async () => {
    const log = new BranchLog('app', 'vanished')
    log.line('only in memory now')
    await flushed(log, 'only in memory now')
    unlinkSync(log.path)
    assert.equal(await log.fileTail(5), 'only in memory now')
  })

  it('keeps the last twenty runs', () => {
    const dir = logsDir('app', 'rotation')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z.log`), '')
    }
    new BranchLog('app', 'rotation')
    const left = readdirSync(dir).sort()
    assert.equal(left.length, 20)
    assert.equal(left[0], '2026-01-01T00-00-05-000Z.log')
  })
})
