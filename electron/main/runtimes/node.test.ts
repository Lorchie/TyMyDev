import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runtimeDir } from '../paths'
import { cleanup, platformSlug, useUserData } from '../testing'
import { cachedNode } from './node'

let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))

function install(version: string, complete = true): void {
  const dir = runtimeDir('node', `node-${version}-${platformSlug}`)
  mkdirSync(dir, { recursive: true })
  if (!complete) return
  const bin = process.platform === 'win32' ? join(dir, 'node.exe') : join(dir, 'bin', 'node')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '')
}

const id = (version: string): string => `node-${version}-${platformSlug}`

describe('cachedNode', () => {
  it('finds nothing in an empty store', () => {
    assert.equal(cachedNode(), null)
    assert.equal(cachedNode('20'), null)
  })

  it('serves the shipped version for no request, its major line and ranges it satisfies', () => {
    install('22.23.2')
    for (const request of [undefined, '22', '22.x', 'v22.23.2', '>=18', '>= 20.0.0', '*', 'lts/*']) {
      assert.equal(cachedNode(request)?.id, id('22.23.2'), String(request))
    }
  })

  it('takes an exact version as it is', () => {
    assert.equal(cachedNode('20.19.5'), null)
  })

  it('takes the newest installed release of another major line, never its x.0.0', () => {
    install('20.1.0')
    install('20.9.0')
    install('20.19.5')
    assert.equal(cachedNode('20')?.id, id('20.19.5'))
    assert.equal(cachedNode('^20.17.0')?.id, id('20.19.5'))
    assert.equal(cachedNode('>=18 <21'), null, 'a bounded range names its lower major')
  })

  it('skips a release whose download never completed', () => {
    install('24.1.0')
    install('24.2.0', false)
    assert.equal(cachedNode('24')?.id, id('24.1.0'))
  })

  it('ignores the staging folder of an interrupted extraction', () => {
    mkdirSync(runtimeDir('node', `${id('26.0.0')}.incoming`), { recursive: true })
    assert.equal(cachedNode('26'), null)
  })
})
