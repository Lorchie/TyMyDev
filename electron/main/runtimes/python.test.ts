import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { BranchLog } from '../logger'
import { cleanup, useUserData } from '../testing'
import { ensurePython, ensureUv } from './python'

const network = process.env.TRYMYDEV_NETWORK_TESTS === '1'
let data: string

before(() => {
  data = useUserData()
})
after(() => cleanup(data))

describe('ensurePython', { skip: network ? false : 'downloads uv and Python: set TRYMYDEV_NETWORK_TESTS=1' }, () => {
  it('installs the latest release of a minor line through uv, then finds it offline', async () => {
    const log = new BranchLog('app', 'python')
    const uv = await ensureUv(log)
    const python = await ensurePython('3.12', uv, log)

    assert.match(python.id, /^cpython-3\.12\.\d+$/)
    assert.ok(existsSync(python.bin))
    assert.deepEqual(await ensurePython('3.12.x', uv, log), python)
  })
})
