import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as tar from 'tar'
import { BranchLog } from '../logger'
import { tmpDir } from '../paths'
import { cleanup, tempDir, useUserData } from '../testing'
import { fetchArchive, findBinary } from './download'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const files = new Map<string, Buffer | string>()
let data: string
let work: string
let server: Server
let base: string
let archive: Buffer
let log: BranchLog
let count = 0
const dest = (): string => join(work, `runtime-${++count}`)

before(async () => {
  data = useUserData()
  work = tempDir()
  mkdirSync(join(work, 'src', 'runtime-1.0', 'bin'), { recursive: true })
  writeFileSync(join(work, 'src', 'runtime-1.0', 'bin', 'tool.txt'), 'runtime')
  await tar.c({ gzip: true, file: join(work, 'rt.tar.gz'), cwd: join(work, 'src') }, ['runtime-1.0'])
  archive = readFileSync(join(work, 'rt.tar.gz'))

  files.set('/rt.tar.gz', archive)
  files.set('/rt.tar.gz.sha256', `${sha256(archive)}  rt.tar.gz\n`)
  files.set('/SHASUMS256.txt', `${'0'.repeat(64)}  other.tar.gz\n${sha256(archive)}  rt.tar.gz\n`)
  files.set('/wrong.sha256', `${'f'.repeat(64)}\n`)
  files.set('/garbage.sha256', 'not a digest')

  server = createServer((req, res) => {
    const body = files.get(req.url ?? '')
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  log = new BranchLog('app', 'download')
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await cleanup(work, data)
})

describe('fetchArchive', () => {
  it('verifies, extracts and strips the top folder, leaving no archive behind', async () => {
    const target = dest()
    await fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { url: `${base}/rt.tar.gz.sha256` }, strip: 1, log })
    assert.equal(readFileSync(join(target, 'bin', 'tool.txt'), 'utf-8'), 'runtime')
    assert.match(log.getTail(5), /checksum verified/)
    assert.deepEqual(readdirSync(tmpDir()), [])
  })

  it('picks its own line out of a list of checksums', async () => {
    const target = dest()
    await fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { url: `${base}/SHASUMS256.txt`, file: 'rt.tar.gz' }, strip: 1, log })
    assert.ok(existsSync(join(target, 'bin', 'tool.txt')))
  })

  it('accepts a digest given inline', async () => {
    const target = dest()
    await fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { value: sha256(archive) }, strip: 1, log })
    assert.ok(existsSync(join(target, 'bin', 'tool.txt')))
  })

  it('rejects a mismatch and leaves nothing behind', async () => {
    const target = dest()
    await assert.rejects(
      fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { url: `${base}/wrong.sha256` }, log }),
      /Checksum mismatch for rt\.tar\.gz/
    )
    assert.equal(existsSync(target), false)
    assert.equal(existsSync(`${target}.incoming`), false)
    assert.deepEqual(readdirSync(tmpDir()), [])
  })

  it('refuses to run what it cannot verify', async () => {
    const target = dest()
    await assert.rejects(
      fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { url: `${base}/missing.sha256` }, log }),
      /Checksum unavailable \(HTTP 404\)/
    )
    await assert.rejects(
      fetchArchive({ url: `${base}/rt.tar.gz`, dest: target, checksum: { url: `${base}/garbage.sha256` }, log }),
      /Unreadable checksum/
    )
    assert.equal(existsSync(target), false)
  })

  it('reports a failed download', async () => {
    await assert.rejects(
      fetchArchive({ url: `${base}/missing.tar.gz`, dest: dest(), checksum: { value: '0'.repeat(64) }, log }),
      /Download failed \(HTTP 404\)/
    )
  })

  it('extracts zip archives with the bsdtar of Windows', { skip: process.platform !== 'win32' }, async () => {
    const zip = join(work, 'rt.zip')
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(bsdtar, ['-a', '-cf', zip, '-C', join(work, 'src'), 'runtime-1.0'])
    const body = readFileSync(zip)
    files.set('/rt.zip', body)

    const target = dest()
    await fetchArchive({ url: `${base}/rt.zip`, dest: target, checksum: { value: sha256(body) }, strip: 1, log })
    assert.equal(readFileSync(join(target, 'bin', 'tool.txt'), 'utf-8'), 'runtime')
  })
})

describe('findBinary', () => {
  it('looks at the top of a folder and one level down', async () => {
    const dir = join(work, 'find')
    mkdirSync(join(dir, 'uv-1.0'), { recursive: true })
    writeFileSync(join(dir, 'uv-1.0', 'uv.exe'), '')
    writeFileSync(join(dir, 'top.exe'), '')
    assert.equal(await findBinary(dir, 'top.exe'), join(dir, 'top.exe'))
    assert.equal(await findBinary(dir, 'uv.exe'), join(dir, 'uv-1.0', 'uv.exe'))
    assert.equal(await findBinary(dir, 'missing.exe'), undefined)
  })
})
