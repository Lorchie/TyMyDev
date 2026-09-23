import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentRequest } from '../overlay/agent'
import { Driver, parseKey, renderTree, SNAPSHOT_CHARS, type AXNode } from './drive'
import type { Channel } from './link'

const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AXNode> = {}): AXNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  ...extra
})

/** A page: a banner with a title, a form with a field and a button, and wrappers around them. */
const PAGE: AXNode[] = [
  node('1', 'RootWebArea', 'Modly', ['2', '6']),
  node('2', 'banner', '', ['3']),
  node('3', 'generic', '', ['4']),
  node('4', 'heading', 'Settings', ['5'], { backendDOMNodeId: 40 }),
  node('5', 'StaticText', 'Settings'),
  node('6', 'generic', '', ['7', '9', '11', '12']),
  node('7', 'textbox', 'Name', [], { backendDOMNodeId: 70, value: { value: 'Mesh' }, properties: [{ name: 'focused', value: { value: true } }] }),
  node('8', 'StaticText', 'unreachable'),
  node('9', 'button', 'Save', ['10'], { backendDOMNodeId: 90, properties: [{ name: 'disabled', value: { value: true } }] }),
  node('10', 'StaticText', 'Save'),
  node('11', 'button', '', [], { backendDOMNodeId: 110 }),
  node('12', 'none', '', ['13'], { ignored: true }),
  node('13', 'StaticText', 'Saved 2 minutes ago')
]

describe('renderTree', () => {
  it('shows what a person sees, with references on what they can act on', () => {
    const { text, refs } = renderTree(PAGE)
    assert.equal(
      text,
      [
        '- banner',
        '  - heading "Settings" [ref=e1]',
        '- textbox "Name" [focused]: "Mesh" [ref=e2]',
        '- button "Save" [disabled] [ref=e3]',
        '- button [ref=e4]',
        '- text: "Saved 2 minutes ago"'
      ].join('\n')
    )
    assert.deepEqual([...refs], [['e1', 40], ['e2', 70], ['e3', 90], ['e4', 110]])
  })

  it('reads text split into pieces as one line, and a control spelling out its name once', () => {
    const { text } = renderTree([
      node('1', 'RootWebArea', '', ['2', '6']),
      node('2', 'paragraph', '', ['3', '4', '5']),
      node('3', 'StaticText', '6'),
      node('4', 'StaticText', 'installed'),
      node('5', 'StaticText', '· 5 processors'),
      node('6', 'button', 'All 6', ['7', '8'], { backendDOMNodeId: 60 }),
      node('7', 'StaticText', 'All'),
      node('8', 'generic', '', ['9']),
      node('9', 'StaticText', '6')
    ])
    assert.equal(text, ['- text: "6 installed · 5 processors"', '- button "All 6" [ref=e1]'].join('\n'))
  })

  it('cuts a page too long to read at once', () => {
    const many = Array.from({ length: 2000 }, (_, i) => node(`n${i}`, 'button', `Button number ${i} of a very long list`, [], { backendDOMNodeId: i }))
    const { text } = renderTree([node('root', 'RootWebArea', '', many.map((n) => n.nodeId)), ...many])
    assert.ok(text.length < SNAPSHOT_CHARS + 200)
    assert.match(text, /cut: the page is longer/)
  })
})

describe('parseKey', () => {
  it('reads keys and shortcuts', () => {
    assert.deepEqual(parseKey('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
    assert.deepEqual(parseKey('Control+s'), { key: 's', code: 'KeyS', keyCode: 83, text: 's', modifiers: 2 })
    assert.equal(parseKey('Shift+Tab').modifiers, 8)
    assert.equal(parseKey('escape').key, 'Escape')
    assert.equal(parseKey('F5').keyCode, 116)
    assert.equal(parseKey('7').code, 'Digit7')
  })

  it('refuses what it does not know', () => {
    assert.throws(() => parseKey('Hyper+a'), /Unknown modifier "Hyper"/)
    assert.throws(() => parseKey('Launch'), /Unknown key "Launch"/)
  })
})

/** An application with one window showing PAGE, recording what it is sent. */
function fakeApp(): { channel: Channel; sent: Array<{ method: string; params?: Record<string, unknown> }> } {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  const channel: Channel = {
    close: () => undefined,
    request: async <T>(request: AgentRequest): Promise<T> => {
      if (request.op === 'windows') return [{ id: 3, title: 'Modly', focused: true }] as T
      if (request.op !== 'cdp') throw new Error('unexpected')
      sent.push({ method: request.method, params: request.params })
      if (request.method === 'Accessibility.getFullAXTree') return { nodes: PAGE } as T
      if (request.method === 'DOM.getContentQuads') {
        if (request.params?.backendNodeId === 110) throw new Error('No node with given id found')
        return { quads: [[100, 20, 180, 20, 180, 60, 100, 60]] } as T
      }
      if (request.method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } } as T
      if (request.method === 'Page.captureScreenshot') return { data: 'UE5H' } as T
      return {} as T
    }
  }
  return { channel, sent }
}

const inputs = (sent: Array<{ method: string; params?: Record<string, unknown> }>): unknown[] =>
  sent.filter((s) => s.method.startsWith('Input.')).map((s) => ({ method: s.method, ...s.params }))

describe('Driver', () => {
  it('clicks the centre of an element of the last snapshot, as a mouse would', async () => {
    const { channel, sent } = fakeApp()
    const driver = new Driver(channel)
    await driver.snapshot()
    assert.equal(await driver.click('e3'), 3)
    assert.deepEqual(inputs(sent), [
      { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 140, y: 40 },
      { method: 'Input.dispatchMouseEvent', type: 'mousePressed', x: 140, y: 40, button: 'left', clickCount: 1 },
      { method: 'Input.dispatchMouseEvent', type: 'mouseReleased', x: 140, y: 40, button: 'left', clickCount: 1 }
    ])
    assert.ok(sent.some((s) => s.method === 'DOM.scrollIntoViewIfNeeded' && s.params?.backendNodeId === 90))
  })

  it('asks for a snapshot before an element is named, and a new one once the page changed', async () => {
    const driver = new Driver(fakeApp().channel)
    await assert.rejects(driver.click('e1'), /take a snapshot first/)
    await driver.snapshot()
    await assert.rejects(driver.click('e9'), /No element e9/)
    await assert.rejects(driver.click('e4'), /the page changed — take a new snapshot/)
  })

  it('types over what a field holds, then submits', async () => {
    const { channel, sent } = fakeApp()
    const driver = new Driver(channel)
    await driver.snapshot()
    await driver.type('e2', 'Chair', true)
    const keys = inputs(sent).filter((i) => (i as { method: string }).method !== 'Input.dispatchMouseEvent')
    assert.deepEqual(keys, [
      { method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] },
      { method: 'Input.dispatchKeyEvent', type: 'keyUp', key: 'a', code: 'KeyA' },
      { method: 'Input.insertText', text: 'Chair' },
      { method: 'Input.dispatchKeyEvent', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, type: 'keyDown', text: '\r' },
      { method: 'Input.dispatchKeyEvent', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, type: 'keyUp' }
    ])
  })

  it('presses a shortcut without typing its letter', async () => {
    const { channel, sent } = fakeApp()
    await new Driver(channel).press('Control+S')
    assert.deepEqual(inputs(sent)[0], {
      method: 'Input.dispatchKeyEvent',
      key: 'S',
      code: 'KeyS',
      windowsVirtualKeyCode: 83,
      modifiers: 2,
      type: 'rawKeyDown'
    })
  })

  it('scrolls from the middle of the window by most of a screen', async () => {
    const { channel, sent } = fakeApp()
    await new Driver(channel).scroll('down', undefined)
    assert.deepEqual(inputs(sent), [{ method: 'Input.dispatchMouseEvent', type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 640 }])
  })

  it('waits for a text the page shows, and gives up on one it does not', async () => {
    const driver = new Driver(fakeApp().channel)
    assert.equal(await driver.waitFor('saved 2 MINUTES', 5), true)
    assert.equal(await driver.waitFor('Generation failed', 0.6), false)
  })

  it('refuses a window that is not open', async () => {
    await assert.rejects(new Driver(fakeApp().channel).snapshot(8), /No window 8\. Open windows: 3 "Modly"/)
  })
})
