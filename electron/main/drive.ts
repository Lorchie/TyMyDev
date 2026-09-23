import type { WindowInfo } from '../overlay/agent'
import type { JournalSnapshot } from '../overlay/journal'
import type { Channel } from './link'

/**
 * Acting on a tested application as a tester does, through the Chrome DevTools Protocol:
 * the page read as its accessibility tree, elements named by the references of the last
 * snapshot, and real input events — which the journal records like a person's.
 */

interface AXValue {
  value?: unknown
}

export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  backendDOMNodeId?: number
}

/** Roles that only group others: their children are shown in their place. */
const TRANSPARENT = new Set(['none', 'generic', 'GenericContainer', 'InlineTextBox', 'LineBreak', 'presentation', 'Section', 'group', 'paragraph'])
/** Roles that say nothing without a name. */
const SILENT = new Set(['image', 'img', 'separator'])
/** Roles a tester acts on: they always get a reference. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'ListBoxOption',
  'PopUpButton',
  'ToggleButton',
  'MenuListPopup'
])
const STATES = ['focused', 'disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'readonly'] as const
const TEXT_CHARS = 200
export const SNAPSHOT_CHARS = 40_000

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const short = (value: string): string => {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > TEXT_CHARS ? `${one.slice(0, TEXT_CHARS)}…` : one
}
const quote = (value: string): string => JSON.stringify(short(value))
const squash = (value: string): string => value.replace(/\s+/g, '').toLowerCase()

/**
 * The tree as indented lines, `- role "name" [state] [ref=e12]`. Wrappers without a name
 * vanish, and a text repeating its parent's name is not said twice.
 */
export function renderTree(nodes: AXNode[]): { text: string; refs: Map<string, number> } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const refs = new Map<string, number>()
  const lines: string[] = []
  const children = new Set(nodes.flatMap((node) => node.childIds ?? []))
  const root = nodes.find((node) => !children.has(node.nodeId))

  const walk = (node: AXNode | undefined, depth: number, parentName: string): void => {
    if (!node) return
    const inPlace = (): void => {
      for (const id of node.childIds ?? []) walk(byId.get(id), depth, parentName)
    }
    const role = text(node.role?.value)
    const name = short(text(node.name?.value))
    if (node.ignored || role === 'RootWebArea' || role === 'WebArea') return inPlace()
    if (role === 'StaticText') {
      if (name && name !== parentName) lines.push(`${'  '.repeat(depth)}- text: ${quote(name)}`)
      return
    }
    if (TRANSPARENT.has(role) && !name) return inPlace()
    if (SILENT.has(role) && !name && !node.childIds?.length) return

    let line = `${'  '.repeat(depth)}- ${role}${name ? ` ${quote(name)}` : ''}`
    for (const state of STATES) {
      const value = node.properties?.find((p) => p.name === state)?.value?.value
      if (value === true) line += ` [${state}]`
      else if (state === 'checked' && value === 'mixed') line += ' [checked=mixed]'
    }
    const value = text(node.value?.value)
    if (value && value !== name) line += `: ${quote(value)}`
    if (node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || name)) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      line += ` [ref=${ref}]`
    }
    lines.push(line)
    // A control whose text only spells out its name says it once.
    const spelled = textOf(node)
    if (spelled !== undefined && (spelled === '' || squash(spelled) === squash(name))) return
    for (const id of node.childIds ?? []) walk(byId.get(id), depth + 1, name)
  }

  /** All a node holds, when it is only text and wrappers; undefined as soon as it holds more. */
  const textOf = (node: AXNode): string | undefined => {
    const parts: string[] = []
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (!child) continue
      const role = text(child.role?.value)
      if (role === 'StaticText') parts.push(text(child.name?.value))
      else if (child.ignored || (TRANSPARENT.has(role) && !text(child.name?.value)) || SILENT.has(role)) {
        const inner = textOf(child)
        if (inner === undefined) return undefined
        parts.push(inner)
      } else return undefined
    }
    return parts.join(' ')
  }
  walk(root, 0, '')

  // Text a page splits into pieces — "6", "installed", "·" — reads as one line.
  const merged: string[] = []
  for (const line of lines) {
    const previous = merged[merged.length - 1]
    const piece = /^(\s*)- text: (".*")$/.exec(line)
    const last = previous !== undefined ? /^(\s*)- text: (".*")$/.exec(previous) : null
    if (piece && last && piece[1] === last[1]) {
      const joined = `${JSON.parse(last[2]) as string} ${JSON.parse(piece[2]) as string}`
      merged[merged.length - 1] = `${last[1]}- text: ${JSON.stringify(joined.length > TEXT_CHARS * 2 ? `${joined.slice(0, TEXT_CHARS * 2)}…` : joined)}`
    } else merged.push(line)
  }

  let out = merged.join('\n')
  if (out.length > SNAPSHOT_CHARS) out = `${out.slice(0, SNAPSHOT_CHARS)}\n… (cut: the page is longer — scroll, or act on what is shown)`
  return { text: out, refs }
}

// ── Keys ──────────────────────────────────────────────────────────────────────

interface KeyInfo {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED: Record<string, KeyInfo> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

/** `Enter`, `a`, `Control+S`, `Shift+Tab`, `F5`: the key and the modifiers held. */
export function parseKey(combo: string): KeyInfo & { modifiers: number } {
  const parts = combo.split('+').map((part) => part.trim())
  const last = parts.pop() ?? ''
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()]
    if (bit === undefined) throw new Error(`Unknown modifier "${part}" in "${combo}": use Control, Shift, Alt or Meta.`)
    modifiers |= bit
  }
  const named = Object.entries(NAMED).find(([name]) => name.toLowerCase() === last.toLowerCase())?.[1]
  if (named) return { ...named, modifiers }
  const fn = /^f(\d{1,2})$/i.exec(last)
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 12) {
    return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]), modifiers }
  }
  if ([...last].length === 1) {
    const upper = last.toUpperCase()
    const code = /[a-z]/i.test(last) ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : ''
    return { key: last, code, keyCode: upper.charCodeAt(0), text: last, modifiers }
  }
  throw new Error(`Unknown key "${last}": use a single character, F1-F12, or one of ${Object.keys(NAMED).join(', ')}.`)
}

// ── Driving one application ───────────────────────────────────────────────────

const SETTLE_MS = 400

export class Driver {
  /** References of the last snapshot, per window. */
  private readonly refs = new Map<number, Map<string, number>>()

  constructor(private readonly channel: Channel) {}

  close(): void {
    this.channel.close()
  }

  windows(): Promise<WindowInfo[]> {
    return this.channel.request<WindowInfo[]>({ op: 'windows' })
  }

  /** The window asked for, else the focused one, else the first. Waits for one to open. */
  async window(id?: number): Promise<number> {
    const until = Date.now() + 30_000
    for (;;) {
      const list = await this.windows()
      if (id !== undefined) {
        if (list.some((w) => w.id === id)) return id
        throw new Error(`No window ${id}. Open windows: ${list.map((w) => `${w.id} "${w.title}"`).join(', ') || 'none'}.`)
      }
      const chosen = list.find((w) => w.focused) ?? list[0]
      if (chosen) return chosen.id
      if (Date.now() > until) throw new Error('The application has no window open.')
      await sleep(500)
    }
  }

  private cdp<T>(window: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.channel.request<T>({ op: 'cdp', window, method, params })
  }

  async snapshot(windowId?: number): Promise<{ window: number; title: string; text: string }> {
    const window = await this.window(windowId)
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>(window, 'Accessibility.getFullAXTree')
    const { text: tree, refs } = renderTree(nodes)
    this.refs.set(window, refs)
    const title = (await this.windows()).find((w) => w.id === window)?.title ?? ''
    return { window, title, text: tree }
  }

  private node(window: number, ref: string): number {
    const id = this.refs.get(window)?.get(ref)
    if (id === undefined) throw new Error(`No element ${ref} in the last snapshot of window ${window}: take a snapshot first.`)
    return id
  }

  /** The centre of an element, scrolled into view. */
  private async centre(window: number, ref: string): Promise<{ x: number; y: number }> {
    const backendNodeId = this.node(window, ref)
    try {
      await this.cdp(window, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      const { quads } = await this.cdp<{ quads: number[][] }>(window, 'DOM.getContentQuads', { backendNodeId })
      const quad = quads?.[0]
      if (!quad) throw new Error('it is not displayed')
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(`Element ${ref} cannot be reached (${why}): the page changed — take a new snapshot.`)
    }
  }

  async click(ref: string, windowId?: number, clicks = 1): Promise<number> {
    const window = await this.window(windowId)
    const { x, y } = await this.centre(window, ref)
    await this.cdp(window, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let count = 1; count <= clicks; count++) {
      await this.cdp(window, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count })
      await this.cdp(window, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
    }
    await sleep(SETTLE_MS)
    return window
  }

  /** Replaces what the field holds, as selecting all and typing over it would. */
  async type(ref: string, value: string, submit: boolean, windowId?: number): Promise<number> {
    const window = await this.click(ref, windowId)
    await this.cdp(window, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] })
    await this.cdp(window, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
    if (value === '') await this.key(window, parseKey('Delete'))
    else await this.cdp(window, 'Input.insertText', { text: value })
    if (submit) await this.key(window, parseKey('Enter'))
    await sleep(SETTLE_MS)
    return window
  }

  async press(combo: string, windowId?: number): Promise<number> {
    const key = parseKey(combo)
    const window = await this.window(windowId)
    await this.key(window, key)
    await sleep(SETTLE_MS)
    return window
  }

  private async key(window: number, key: KeyInfo & { modifiers: number }): Promise<void> {
    // A shortcut types nothing: Control+S saves, it does not write "s".
    const typed = key.text !== undefined && (key.modifiers & (1 | 2 | 4)) === 0 ? key.text : undefined
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: key.modifiers }
    await this.cdp(window, 'Input.dispatchKeyEvent', { ...base, type: typed ? 'keyDown' : 'rawKeyDown', ...(typed ? { text: typed } : {}) })
    await this.cdp(window, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  async scroll(direction: 'up' | 'down', ref: string | undefined, windowId?: number): Promise<number> {
    const window = await this.window(windowId)
    const metrics = await this.cdp<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(window, 'Page.getLayoutMetrics')
    const { clientWidth, clientHeight } = metrics.cssVisualViewport
    const at = ref ? await this.centre(window, ref) : { x: clientWidth / 2, y: clientHeight / 2 }
    const deltaY = (direction === 'down' ? 1 : -1) * Math.round(clientHeight * 0.8)
    await this.cdp(window, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY })
    await sleep(SETTLE_MS)
    return window
  }

  async screenshot(windowId?: number): Promise<{ window: number; png: string }> {
    const window = await this.window(windowId)
    const { data } = await this.cdp<{ data: string }>(window, 'Page.captureScreenshot', { format: 'png' })
    return { window, png: data }
  }

  journal(): Promise<JournalSnapshot> {
    return this.channel.request<JournalSnapshot>({ op: 'journal' })
  }

  async report(description: string, screenshot: boolean, windowId?: number): Promise<string> {
    const window = await this.window(windowId)
    return this.channel.request<string>({ op: 'report', window, description, screenshot })
  }

  /** Until the page shows `text`, or `seconds` have passed. */
  async waitFor(text: string | undefined, seconds: number, windowId?: number): Promise<boolean> {
    const until = Date.now() + seconds * 1000
    if (!text) {
      await sleep(seconds * 1000)
      return true
    }
    const wanted = text.toLowerCase()
    for (;;) {
      const snap = await this.snapshot(windowId)
      if (snap.text.toLowerCase().includes(wanted)) return true
      if (Date.now() > until) return false
      await sleep(500)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
