import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hintFor, tidyTail } from './hints'

describe('hintFor', () => {
  it('explains a torch built without CUDA', () => {
    assert.match(hintFor('AssertionError: Torch not compiled with CUDA enabled') ?? '', /PyTorch index/)
  })

  it('names the missing Python or Node module', () => {
    assert.match(hintFor("ModuleNotFoundError: No module named 'yaml'") ?? '', /"yaml" is missing/)
    assert.match(hintFor("Error: Cannot find module 'vite'") ?? '', /"vite" is missing/)
  })

  it('recognises a taken port, native builds, long paths, a full disk, locked files and the network', () => {
    for (const [text, expected] of [
      ['Error: listen EADDRINUSE: address already in use 127.0.0.1:8188', /port is already taken/],
      ['gyp ERR! find VS', /build tools/],
      ['error: Microsoft Visual C++ 14.0 or greater is required.', /build tools/],
      ['ENAMETOOLONG: name too long', /260 characters/],
      ['ENOSPC: no space left on device, write', /disk is full/],
      ['EBUSY: resource busy or locked, rmdir', /held by another program/],
      ['TypeError: fetch failed', /network/],
      ['api.github.com sent nothing for 60 s — the connection was dropped.', /network/],
      ['RuntimeError: No CUDA GPUs are available', /NVIDIA GPU or driver/],
      ['RuntimeError: CUDA error: no kernel image is available for execution on the device', /does not support this GPU/],
      ['npm error code SELF_SIGNED_CERT_IN_CHAIN self-signed certificate in certificate chain', /UV_SYSTEM_CERTS/],
      ['error: invalid peer certificate: UnknownIssuer', /certificate/],
      ['Error: spawn C:\\data\\store\\uv\\uv.exe EACCES', /company policy/],
      ["_pickle.UnpicklingError: invalid load key, 'v'.", /Git LFS/],
      ["Command failed (exit code 9009): cmake --build .", /not on this computer/]
    ] as const) {
      assert.match(hintFor(text) ?? '', expected, text)
    }
  })

  it('stays silent about failures it does not know', () => {
    assert.equal(hintFor('SyntaxError: Unexpected token'), undefined)
  })
})

describe('tidyTail', () => {
  it('cuts long lines and leaves the others alone', () => {
    const [first, second] = tidyTail(`short\n${'x'.repeat(1000)}`, 300).split('\n')
    assert.equal(first, 'short')
    assert.equal(second.length, 302)
    assert.ok(second.endsWith(' …'))
  })
})
