import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  actionText,
  recorder,
  RECORDER_SOURCE,
  type RawAction,
  type RecordedElement,
  type RecordedEvent,
  type RecorderWindow
} from './recorder'

interface FakeElement extends RecordedElement {
  parent?: FakeElement
  value?: string
}

/** Enough of `matches` for the recorder's selectors: `tag`, `[attr=value]`, `tag[attr=value]`. */
function matchesOne(el: FakeElement, selector: string): boolean {
  const match = selector.trim().match(/^([a-z]+)?(?:\[([\w-]+)=("?)([^"\]]*)\3\])?$/)
  if (!match) return false
  const [, tag, attr, , value] = match
  if (tag && el.tagName.toLowerCase() !== tag) return false
  if (attr && el.getAttribute(attr) !== value) return false
  return true
}

function element(
  tag: string,
  attrs: Record<string, string> = {},
  extra: Partial<FakeElement> & { parent?: FakeElement } = {}
): FakeElement {
  const el: FakeElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id ?? '',
    className: attrs.class ?? '',
    textContent: null,
    type: attrs.type,
    getAttribute: (name) => attrs[name] ?? null,
    matches: (selector) => selector.split(',').some((one) => matchesOne(el, one)),
    closest: (selector) => {
      for (let node: FakeElement | undefined = el; node; node = node.parent) if (node.matches(selector)) return node
      return null
    },
    ...extra
  }
  return el
}

let listeners: Record<string, (event: RecordedEvent) => void>
let win: RecorderWindow
const body = element('body')

beforeEach(() => {
  listeners = {}
  win = {
    document: {
      body,
      addEventListener: (type, listener) => {
        listeners[type] = listener
      }
    }
  }
  recorder(win)
})

const fire = (type: string, event: RecordedEvent): void => listeners[type](event)
const taken = (): string[] => win.__tmdTake!().map(actionText)

describe('recorder', () => {
  it('names what was clicked by its role and short text', () => {
    const button = element('button', { id: 'run' }, { textContent: '  Generate\n mesh ', parent: body })
    const icon = element('span', {}, { parent: button })
    fire('click', { target: icon })
    fire('click', { target: element('div', { role: 'tab' }, { textContent: 'Chat', parent: body }) })
    assert.deepEqual(taken(), ['Clicked button#run "Generate mesh"', 'Clicked tab "Chat"'])
  })

  it('never takes the text of content that is not a control', () => {
    const message = element('p', { class: 'message user bubble' }, { textContent: 'my private prompt about my house', parent: body })
    const longLink = element('a', {}, { textContent: 'x'.repeat(80), parent: body })
    fire('click', { target: message })
    fire('click', { target: longLink })
    assert.deepEqual(taken(), ['Clicked p.message.user', 'Clicked a'])
  })

  it('records typing in a field once per burst, by its label, never its value', () => {
    const field = element('input', { type: 'email' }, { labels: [{ textContent: 'E-mail' }], value: 'jane@example.com', parent: body })
    fire('input', { target: field })
    fire('input', { target: field })
    fire('input', { target: element('textarea', { placeholder: 'Describe the scene' }, { parent: body }) })
    const actions = taken()
    assert.deepEqual(actions, ['Typed in input[email] "E-mail"', 'Typed in textarea "Describe the scene"'])
    assert.ok(!actions.join().includes('jane'))
  })

  it('ignores password fields entirely', () => {
    const password = element('input', { type: 'password', 'aria-label': 'Password' }, { parent: body })
    fire('click', { target: password })
    fire('input', { target: password })
    fire('change', { target: password })
    fire('keydown', { target: password, key: 'v', ctrlKey: true })
    assert.deepEqual(taken(), [])
  })

  it('records choices without the names of files', () => {
    fire('change', { target: element('input', { type: 'checkbox', 'aria-label': 'Use GPU' }, { checked: true }) })
    fire('change', {
      target: element('select', { name: 'model' }, { selectedOptions: [{ textContent: ' Hunyuan3D mini ' }] })
    })
    fire('change', {
      target: element('input', { type: 'file', title: 'Image' }, { files: [{ name: 'Jérôme portrait.PNG' }, { name: 'b.jpg' }] })
    })
    fire('drop', { target: element('canvas', { id: 'viewport' }), dataTransfer: { files: [{ name: 'secret-plan.glb' }] } })
    const actions = taken()
    assert.deepEqual(actions, [
      'Changed input[checkbox] "Use GPU" to checked',
      'Changed select "model" to "Hunyuan3D mini"',
      'Chose 2 files (.png, .jpg) in input[file] "Image"',
      'Chose 1 file (.glb) in canvas#viewport'
    ])
    assert.ok(!actions.join().includes('portrait'))
  })

  it('records shortcuts and acting keys, never typed characters', () => {
    const input = element('input', { 'aria-label': 'Search' }, { parent: body })
    const area = element('textarea', { 'aria-label': 'Prompt' }, { parent: body })
    fire('keydown', { target: input, key: 'a' })
    fire('keydown', { target: input, key: 'A', shiftKey: true })
    fire('keydown', { target: body, key: 'z', ctrlKey: true })
    fire('keydown', { target: body, key: '@', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' })
    fire('keydown', { target: area, key: 'Enter' })
    fire('keydown', { target: input, key: 'Enter' })
    fire('keydown', { target: body, key: 'Escape' })
    fire('keydown', { target: body, key: 'Control', ctrlKey: true })
    fire('keydown', { target: body, key: 's', ctrlKey: true, repeat: true })
    assert.deepEqual(taken(), ['Pressed Ctrl+Z', 'Pressed Enter in input[text] "Search"', 'Pressed Escape'])
  })

  it('records form submissions', () => {
    fire('submit', { target: element('form', { id: 'login' }) })
    assert.deepEqual(taken(), ['Submitted form#login'])
  })

  it('hands its actions over once, and keeps only the last ones', () => {
    for (let i = 0; i < 350; i++) fire('click', { target: element('button', {}, { textContent: `b${i}` }) })
    const actions = win.__tmdTake!()
    assert.equal(actions.length, 300)
    assert.equal(actions.at(-1)?.target, 'button "b349"')
    assert.deepEqual(win.__tmdTake!(), [])
  })

  it('runs from its serialized source, once per page', () => {
    const registered: string[] = []
    const page: RecorderWindow = { document: { body, addEventListener: (type) => void registered.push(type) } }
    const run = new Function('window', RECORDER_SOURCE) as (w: RecorderWindow) => void
    run(page)
    run(page)
    assert.deepEqual(registered.sort(), ['change', 'click', 'drop', 'input', 'keydown', 'submit'])
    assert.equal(typeof page.__tmdTake, 'function')
  })
})

describe('actionText', () => {
  it('reads every kind of action', () => {
    const text = (action: Omit<RawAction, 't'>): string => actionText({ t: 0, ...action })
    assert.equal(text({ kind: 'click' }), 'Clicked')
    assert.equal(text({ kind: 'change', target: 'select' }), 'Changed select')
    assert.equal(text({ kind: 'files' }), 'Chose files')
    assert.equal(text({ kind: 'key', detail: 'F5' }), 'Pressed F5')
  })
})
