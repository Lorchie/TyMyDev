import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { download, proxyUrl, request } from './network'
import { cleanup, tempDir } from './testing'

let server: Server
let base: string
let work: string
const hanging: ServerResponse[] = []

before(async () => {
  work = tempDir()
  server = createServer((req, res) => {
    if (req.url === '/silent') {
      hanging.push(res)
      return
    }
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-length': '1000' })
      res.write('x'.repeat(10))
      hanging.push(res)
      return
    }
    if (req.url === '/not-modified') {
      res.writeHead(304).end()
      return
    }
    res.writeHead(200).end('hello')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(async () => {
  for (const res of hanging) res.destroy()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await cleanup(work)
})

const ok = (res: Response): void => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

describe('request', () => {
  it('returns the whole answer, and a 304 without a body', async () => {
    assert.equal(await (await request(`${base}/`)).text(), 'hello')
    assert.equal((await request(`${base}/not-modified`)).status, 304)
  })

  it('gives up on a server that never answers, saying so', async () => {
    await assert.rejects(request(`${base}/silent`, { answerMs: 300 }), /did not answer for 0 s — the connection was dropped/)
  })

  it('stops at once when the job is cancelled', async () => {
    const controller = new AbortController()
    const pending = request(`${base}/silent`, { signal: controller.signal })
    controller.abort(new Error('Cancelled by the user'))
    await assert.rejects(pending)
  })
})

describe('download', () => {
  it('saves the body and reports progress', async () => {
    const dest = join(work, 'ok.bin')
    let received = 0
    await download(`${base}/`, dest, { accept: ok, onProgress: (r) => (received = r) })
    assert.equal(readFileSync(dest, 'utf-8'), 'hello')
    assert.equal(received, 5)
  })

  it('fails when the transfer goes silent, instead of waiting forever', async () => {
    await assert.rejects(
      download(`${base}/stall`, join(work, 'stall.bin'), { accept: ok, idleMs: 300 }),
      /sent nothing for 0 s/
    )
  })

  it('stops a transfer the job cancels', async () => {
    const controller = new AbortController()
    const pending = download(`${base}/stall`, join(work, 'cancelled.bin'), { accept: ok, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('Cancelled by the user')), 100)
    await assert.rejects(pending)
  })

  it('throws what `accept` throws, without saving anything', async () => {
    const dest = join(work, 'refused.bin')
    await assert.rejects(
      download(`${base}/not-modified`, dest, {
        accept: (res) => {
          if (res.status !== 200) throw new Error(`refused ${res.status}`)
        }
      }),
      /refused 304/
    )
    assert.equal(existsSync(dest), false)
  })
})

describe('proxyUrl', () => {
  it('reads the proxy Chromium resolved, and nothing for a direct connection or SOCKS', () => {
    assert.equal(proxyUrl('PROXY proxy.corp:8080; DIRECT'), 'http://proxy.corp:8080')
    assert.equal(proxyUrl('HTTPS secure.corp:443'), 'https://secure.corp:443')
    assert.equal(proxyUrl('DIRECT'), undefined)
    assert.equal(proxyUrl('SOCKS5 socks.corp:1080'), undefined)
  })
})
