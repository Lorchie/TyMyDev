import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactText, redactUrl } from './redact'

const home = process.platform === 'win32' ? 'C:\\Users\\Jérôme' : '/home/jerome'

describe('redactText', () => {
  it('masks tokens whose shape is known', () => {
    const samples = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'glpat-abcdefghijklmnopqrstu',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'hf_abcdefghijklmnopqrstuvwxyzABCD',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    ]
    for (const token of samples) {
      const out = redactText(`loaded ${token} ok`)
      assert.equal(out, 'loaded [redacted] ok', token)
    }
  })

  it('masks a private key across its lines', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----'
    assert.equal(redactText(`key:\n${key}\ndone`), 'key:\n[redacted]\ndone')
  })

  it('keeps the name of a secret and drops its value', () => {
    assert.equal(redactText('GITHUB_TOKEN=abc123 NODE_ENV=dev'), 'GITHUB_TOKEN=[redacted] NODE_ENV=dev')
    assert.equal(redactText('{"password": "hunter2", "user": 1}'), '{"password": [redacted], "user": 1}')
    assert.equal(redactText("api_key: 'xyz'"), 'api_key: [redacted]')
    assert.equal(redactText('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [redacted] [redacted]')
    assert.equal(redactText('sent with Bearer abcdefghijklmnop'), 'sent with Bearer [redacted]')
  })

  it('masks e-mail addresses, credentials and parameters of web addresses', () => {
    assert.equal(redactText('signed in as jane.doe+test@example.co.uk'), 'signed in as [email]')
    assert.equal(redactText('GET https://user:pass@api.example.com/v1'), 'GET https://[user]@api.example.com/v1')
    assert.equal(
      redactText('fetch https://api.example.com/items?q=holiday&key=1 failed'),
      'fetch https://api.example.com/items?… failed'
    )
    assert.equal(redactText('GET https://x.dev/a?b=1: refused.'), 'GET https://x.dev/a?…: refused.')
  })

  it('changes nothing when masking again what it masked', () => {
    const once = redactText('GET https://x.dev/a?b=1: token=abc for me@x.dev in C:\\Users\\Bob\\x')
    assert.equal(redactText(once), once)
  })

  it('replaces the home folder, in either slash, and anybody else’s user folder', () => {
    const withHome = { home }
    if (process.platform === 'win32') {
      assert.equal(redactText('at C:\\Users\\Jérôme\\app\\main.js', withHome), 'at ~\\app\\main.js')
      assert.equal(redactText('at c:/users/jérôme/app/main.js', withHome), 'at ~/app/main.js')
      assert.equal(redactText('"C:\\\\Users\\\\Jérôme\\\\x"', withHome), '"~\\\\x"')
    } else {
      assert.equal(redactText('at /home/jerome/app/main.js', withHome), 'at ~/app/main.js')
    }
    assert.equal(redactText('C:\\Users\\Someone\\file.txt and /Users/other/x', withHome), 'C:\\Users\\[user]\\file.txt and /Users/[user]/x')
  })

  it('masks the computer name', () => {
    assert.equal(redactText('connected to DESKTOP-4F2K9 on port 80', { hostname: 'DESKTOP-4F2K9' }), 'connected to [host] on port 80')
  })

  it('masks public IPv4 addresses only', () => {
    assert.equal(
      redactText('from 82.64.12.7 to 127.0.0.1, 192.168.1.20, 10.0.0.2 and 172.20.1.1'),
      'from [ip] to 127.0.0.1, 192.168.1.20, 10.0.0.2 and 172.20.1.1'
    )
    assert.equal(redactText('Chrome/132.0.6834.83 and Windows 10.0.26200'), 'Chrome/132.0.6834.83 and Windows 10.0.26200')
  })

  it('leaves ordinary log lines alone', () => {
    const line = '[FastAPI] INFO: Uvicorn running on http://127.0.0.1:8765 (Press CTRL+C to quit) — model hunyuan3d-mini/generate'
    assert.equal(redactText(line), line)
  })
})

describe('redactUrl', () => {
  it('drops credentials, parameters and data fragments, and keeps routes', () => {
    assert.equal(redactUrl('https://me:secret@example.com/app/page?session=1#/models'), 'https://example.com/app/page?…#/models')
    assert.equal(redactUrl('http://localhost:5173/callback#access_token=abc&state=1'), 'http://localhost:5173/callback#…')
    assert.equal(redactUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188/')
  })

  it('masks the home folder of a file address', () => {
    const file = process.platform === 'win32' ? 'file:///C:/Users/J%C3%A9r%C3%B4me/app/out/index.html#/generate' : 'file:///home/jerome/app/out/index.html#/generate'
    assert.equal(redactUrl(file, { home }), 'file:///~/app/out/index.html#/generate')
  })

  it('falls back to masking text that is no URL', () => {
    assert.equal(redactUrl('not a url token=abc'), 'not a url token=[redacted]')
  })
})
