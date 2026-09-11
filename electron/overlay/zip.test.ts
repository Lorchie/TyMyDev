import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { crc32, zip } from './zip'

/** Reads an archive back through its central directory, checking every size and checksum. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'end of central directory')
  const files = new Map<string, Buffer>()
  let at = archive.readUInt32LE(end + 16)
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50)
    const flags = archive.readUInt16LE(at + 8)
    const method = archive.readUInt16LE(at + 10)
    const crc = archive.readUInt32LE(at + 16)
    const compressed = archive.readUInt32LE(at + 20)
    const size = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const offset = archive.readUInt32LE(at + 42)
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf-8')
    assert.equal(flags & 0x0800, 0x0800, 'UTF-8 names')

    assert.equal(archive.readUInt32LE(offset), 0x04034b50)
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28)
    const body = archive.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(data.length, size)
    assert.equal(crc32(data), crc)
    files.set(name, data)
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32)
  }
  return files
}

const entries = [
  { name: 'report.md', data: Buffer.from('# Bug report\n'.repeat(200), 'utf-8') },
  { name: 'screenshot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  { name: 'logs – é.txt', data: Buffer.from('line\n', 'utf-8') }
]

describe('crc32', () => {
  it('matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(crc32(Buffer.alloc(0)), 0)
  })
})

describe('zip', () => {
  it('holds every file, deflated when that helps and stored otherwise', () => {
    const archive = zip(entries, new Date(2026, 8, 11, 10, 42, 13))
    const files = unzip(archive)
    assert.deepEqual([...files.keys()], entries.map((e) => e.name))
    for (const entry of entries) assert.deepEqual(files.get(entry.name), entry.data)
    assert.ok(archive.length < entries[0].data.length, 'the repeated text was deflated')
  })

  it('writes an empty archive', () => {
    assert.equal(unzip(zip([])).size, 0)
  })

  it('opens with the archiver Windows ships', (t) => {
    if (process.platform !== 'win32') return t.skip('Windows only')
    const dir = mkdtempSync(join(tmpdir(), 'tmd-zip-'))
    try {
      const path = join(dir, 'report.zip')
      writeFileSync(path, zip(entries))
      // The bsdtar in System32 reads zip archives; Git's GNU tar on PATH does not.
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', path, '-C', dir])
      for (const entry of entries) assert.deepEqual(readFileSync(join(dir, entry.name)), entry.data)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
