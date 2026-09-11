import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withLock } from './lock'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('withLock', () => {
  it('runs holders of one key one at a time, in arrival order', async () => {
    const events: string[] = []
    const holder = (name: string, ms: number): Promise<string> =>
      withLock('shared', async () => {
        events.push(`${name}:start`)
        await sleep(ms)
        events.push(`${name}:end`)
        return name
      })

    assert.deepEqual(await Promise.all([holder('a', 30), holder('b', 5), holder('c', 1)]), ['a', 'b', 'c'])
    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('lets different keys run side by side', async () => {
    let running = 0
    let peak = 0
    const holder = (key: string): Promise<void> =>
      withLock(key, async () => {
        peak = Math.max(peak, ++running)
        await sleep(20)
        running--
      })
    await Promise.all([holder('x'), holder('y'), holder('z')])
    assert.equal(peak, 3)
  })

  it('rejects only the failing holder, and the queue goes on', async () => {
    const failing = withLock('fragile', async () => {
      throw new Error('boom')
    })
    const next = withLock('fragile', async () => 'still runs')
    await assert.rejects(failing, /boom/)
    assert.equal(await next, 'still runs')
  })
})
