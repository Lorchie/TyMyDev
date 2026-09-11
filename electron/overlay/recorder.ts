/**
 * What the tester does in a tested page, recorded from an isolated JavaScript world: the
 * page shares its DOM with it, never its variables, so it can neither see nor feed the
 * recording. The main process takes the actions every second and on navigation (journal.ts).
 *
 * Never recorded: what is typed, the value of a field, a password field at all, the name of
 * a chosen file. A field is only described by its label.
 */

export interface RawAction {
  t: number
  kind: 'click' | 'input' | 'change' | 'key' | 'submit' | 'files'
  target?: string
  detail?: string
}

/** Every world above 999 is free; this one is the recorder's. */
export const RECORDER_WORLD = 1147

type Named = { name: string }
type WithText = { textContent: string | null }

/** The part of the DOM the recorder touches — the main process has no DOM types. */
export interface RecordedElement extends WithText {
  nodeType: number
  tagName: string
  id: string
  className: unknown
  isContentEditable?: boolean
  ownerDocument?: { body: unknown } | null
  closest(selector: string): RecordedElement | null
  matches(selector: string): boolean
  getAttribute(name: string): string | null
  labels?: ArrayLike<WithText> | null
  type?: string
  checked?: boolean
  files?: ArrayLike<Named> | null
  selectedOptions?: ArrayLike<WithText>
}

export interface RecordedEvent {
  target: unknown
  key?: string
  repeat?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  getModifierState?: (key: string) => boolean
  dataTransfer?: { files?: ArrayLike<Named> } | null
}

export interface RecorderWindow {
  document: {
    body: unknown
    addEventListener(type: string, listener: (event: RecordedEvent) => void, options: object): void
  }
  __tmdTake?: () => RawAction[]
}

/**
 * Runs inside the page, serialized with `toString()`: it may use nothing from outside its body.
 * `win` is the page's window as the isolated world sees it.
 */
export function recorder(win: RecorderWindow): void {
  if (win.__tmdTake) return
  const MAX = 300
  let pending: RawAction[] = []
  let lastInput: { el: RecordedElement; at: number } | undefined

  const push = (action: RawAction): void => {
    pending.push(action)
    if (pending.length > MAX) pending = pending.slice(-MAX)
  }

  const INTERACTIVE =
    'button, a, summary, label, select, textarea, input, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [role=option], [role=radio], [contenteditable=""], [contenteditable=true]'

  const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()

  const elementOf = (node: unknown): RecordedElement | undefined => {
    const el = node as RecordedElement | null
    return el && el.nodeType === 1 ? el : undefined
  }

  /** `button "Generate"`, `input[email] "E-mail"`, `canvas#graph`: enough to find it, nothing typed. */
  const describe = (node: unknown): string => {
    const start = elementOf(node)
    if (!start) return 'the page'
    const interactive = start.closest(INTERACTIVE)
    const el = interactive ?? start
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : ''
    const editable = !!el.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select'
    let name = clean(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('alt'))
    if (!name && editable) {
      const label = el.labels && el.labels.length > 0 ? el.labels[0].textContent : null
      name = clean(label ?? el.getAttribute('placeholder') ?? el.getAttribute('name'))
    }
    // Visible text only names what is meant to be clicked, and only when it is short: a
    // paragraph or a chat message is somebody's content.
    if (!name && !editable && interactive) {
      const text = clean(el.textContent)
      if (text.length <= 60) name = text
    }
    const kind = role ?? (type ? `${tag}[${type}]` : tag)
    const id = el.id ? `#${el.id}` : ''
    const classes =
      !id && !name && typeof el.className === 'string' ? clean(el.className).split(' ').filter(Boolean).slice(0, 2) : []
    const testId = el.getAttribute('data-testid')
    return `${kind}${id}${classes.map((c) => `.${c}`).join('')}${name ? ` "${name.slice(0, 60)}"` : ''}${testId ? ` [data-testid=${testId}]` : ''}`
  }

  const isPassword = (node: unknown): boolean => {
    const el = elementOf(node)
    return !!el && el.matches('input[type=password]')
  }

  const extensions = (files: ArrayLike<{ name: string }> | null | undefined): string => {
    const list = Array.from(files ?? [])
    const kinds = [...new Set(list.map((f) => (f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '?')))]
    return `${list.length} file${list.length === 1 ? '' : 's'}${kinds.length ? ` (.${kinds.join(', .')})` : ''}`
  }

  const doc = win.document
  const options = { capture: true, passive: true }

  doc.addEventListener(
    'click',
    (event) => {
      if (isPassword(event.target)) return
      push({ t: Date.now(), kind: 'click', target: describe(event.target) })
    },
    options
  )

  // A burst of keystrokes in one field is one action.
  doc.addEventListener(
    'input',
    (event) => {
      const el = elementOf(event.target)
      if (!el || isPassword(el)) return
      if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file' || el.tagName === 'SELECT') return
      const now = Date.now()
      if (lastInput && lastInput.el === el && now - lastInput.at < 3000) {
        lastInput.at = now
        return
      }
      lastInput = { el, at: now }
      push({ t: now, kind: 'input', target: describe(el) })
    },
    options
  )

  doc.addEventListener(
    'change',
    (event) => {
      const el = elementOf(event.target)
      if (!el || isPassword(el)) return
      const target = describe(el)
      if (el.tagName === 'SELECT') {
        const option = el.selectedOptions && el.selectedOptions.length > 0 ? el.selectedOptions[0] : undefined
        push({ t: Date.now(), kind: 'change', target, detail: option ? `"${clean(option.textContent).slice(0, 60)}"` : undefined })
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        push({ t: Date.now(), kind: 'change', target, detail: el.checked ? 'checked' : 'unchecked' })
      } else if (el.type === 'file') {
        push({ t: Date.now(), kind: 'files', target, detail: extensions(el.files) })
      }
    },
    options
  )

  doc.addEventListener(
    'drop',
    (event) => {
      const files = event.dataTransfer?.files
      if (files && files.length > 0) push({ t: Date.now(), kind: 'files', target: describe(event.target), detail: extensions(files) })
    },
    options
  )

  doc.addEventListener('submit', (event) => push({ t: Date.now(), kind: 'submit', target: describe(event.target) }), options)

  // Shortcuts, and the few keys that act on their own; letters typed without a modifier are text.
  const ACTING = ['Enter', 'Escape', 'Delete', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']
  const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']
  doc.addEventListener(
    'keydown',
    (event) => {
      const key = event.key ?? ''
      if (event.repeat || !key || MODIFIERS.includes(key)) return
      // AltGr is Ctrl+Alt on Windows: it types @, # or € on many keyboards.
      if (event.getModifierState && event.getModifierState('AltGraph')) return
      const target = elementOf(event.target)
      if (isPassword(target)) return
      const modified = !!(event.ctrlKey || event.metaKey || event.altKey)
      if (!modified && !ACTING.includes(key)) return
      if (!modified && key === 'Enter' && target && (target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const combo = [
        event.ctrlKey && 'Ctrl',
        event.metaKey && 'Cmd',
        event.altKey && 'Alt',
        event.shiftKey && 'Shift',
        key.length === 1 ? key.toUpperCase() : key
      ]
        .filter(Boolean)
        .join('+')
      push({ t: Date.now(), kind: 'key', detail: combo, target: target && target !== doc.body ? describe(target) : undefined })
    },
    options
  )

  win.__tmdTake = () => {
    const taken = pending
    pending = []
    return taken
  }
}

export const RECORDER_SOURCE = `(${recorder.toString()})(window)`

/** An action as the report reads it. */
export function actionText(action: RawAction): string {
  const on = action.target ? ` ${action.target}` : ''
  switch (action.kind) {
    case 'click':
      return `Clicked${on}`
    case 'input':
      return `Typed in${on}`
    case 'change':
      return `Changed${on}${action.detail ? ` to ${action.detail}` : ''}`
    case 'files':
      return `Chose ${action.detail ?? 'files'}${action.target ? ` in ${action.target}` : ''}`
    case 'submit':
      return `Submitted${on}`
    case 'key':
      return `Pressed ${action.detail ?? 'a key'}${action.target ? ` in ${action.target}` : ''}`
  }
}
