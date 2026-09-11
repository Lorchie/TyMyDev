import './overlay.css'
import type { OverlayAnchor } from './env'

type View = 'button' | 'menu' | 'report' | 'saved'

interface Tool {
  label: string
  hint?: string
  run: () => void
}

/** Room around what is shown, for its shadow — the view is sized to it. */
const PADDING = 12
/** Below this, a press on the button is a click; beyond, a drag. */
const DRAG_THRESHOLD = 5

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const toggle = byId<HTMLButtonElement>('toggle')
const cards: Record<Exclude<View, 'button'>, HTMLElement> = {
  menu: byId('menu'),
  report: byId('report'),
  saved: byId('saved')
}
const description = byId<HTMLTextAreaElement>('description')
const screenshotBox = byId<HTMLInputElement>('screenshot')
const screenshotRow = byId<HTMLElement>('screenshot-row')
const screenshotPreview = byId<HTMLImageElement>('screenshot-preview')
const markdown = byId<HTMLPreElement>('markdown')
const logsBlock = byId<HTMLDetailsElement>('logs-block')
const logs = byId<HTMLPreElement>('logs')
const reportError = byId<HTMLParagraphElement>('report-error')
const save = byId<HTMLButtonElement>('save')

let view: View = 'button'

/** The natural size of a card: its height limit only applies once the view has grown. */
function measure(el: HTMLElement): { width: number; height: number } {
  const limit = el.style.maxHeight
  el.style.maxHeight = 'none'
  const size = { width: el.offsetWidth, height: el.offsetHeight }
  el.style.maxHeight = limit
  return size
}

function fit(): void {
  const shown = view === 'button' ? toggle : cards[view]
  const { width, height } = measure(shown)
  window.overlay.resize(width + PADDING, height + PADDING, view !== 'button')
}

function show(next: View): void {
  if (view === next) return
  if (view === 'report' || view === 'saved') window.overlay.report.close()
  view = next
  document.body.dataset.view = next
  toggle.setAttribute('aria-expanded', String(next !== 'button'))
  fit()
  if (next === 'menu') cards.menu.querySelector<HTMLButtonElement>('.tool')?.focus()
  if (next === 'saved') cards.saved.querySelector<HTMLButtonElement>('.primary')?.focus()
}

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function showError(text: string): void {
  reportError.textContent = text
  reportError.hidden = false
  fit()
}

// ── Report ──────────────────────────────────────────────────────────────────────

async function startReport(): Promise<void> {
  description.value = ''
  reportError.hidden = true
  markdown.textContent = 'Preparing the report…'
  logs.textContent = ''
  logsBlock.hidden = true
  screenshotBox.checked = true
  screenshotRow.hidden = true
  screenshotPreview.hidden = true
  document.body.classList.remove('no-screenshot')
  save.disabled = true
  show('report')
  try {
    const prepared = await window.overlay.report.start()
    markdown.textContent = prepared.markdown
    logs.textContent = prepared.logs
    logsBlock.hidden = prepared.logs === ''
    if (prepared.screenshot) {
      screenshotPreview.src = prepared.screenshot
      screenshotRow.hidden = false
      screenshotPreview.hidden = false
    } else {
      screenshotBox.checked = false
    }
    save.disabled = false
    fit()
    description.focus()
  } catch (err) {
    showError(`The report could not be prepared: ${messageOf(err)}`)
  }
}

let previewTimer: number | undefined
description.addEventListener('input', () => {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    void window.overlay.report.preview(description.value).then((text) => {
      if (text) markdown.textContent = text
    })
  }, 250)
})

screenshotBox.addEventListener('change', () => {
  document.body.classList.toggle('no-screenshot', !screenshotBox.checked)
})
screenshotPreview.addEventListener('load', fit)
for (const block of document.querySelectorAll('details')) block.addEventListener('toggle', fit)

save.addEventListener('click', async () => {
  save.disabled = true
  reportError.hidden = true
  try {
    const name = await window.overlay.report.save(description.value, screenshotBox.checked)
    if (name) {
      byId('saved-name').textContent = name
      show('saved')
    }
  } catch (err) {
    showError(`The report could not be saved: ${messageOf(err)}`)
  } finally {
    save.disabled = false
  }
})

byId('show').addEventListener('click', () => void window.overlay.report.show())

// ── Menu ────────────────────────────────────────────────────────────────────────

/** The tester's tools, in the order shown. */
const TOOLS: Tool[] = [{ label: 'Report bug', hint: 'Screenshot, recent steps and errors', run: () => void startReport() }]

for (const tool of TOOLS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tool'
  button.textContent = tool.label
  if (tool.hint) {
    const hint = document.createElement('small')
    hint.textContent = tool.hint
    button.append(hint)
  }
  button.addEventListener('click', tool.run)
  byId('tools').append(button)
}

for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => show('button'))

document.addEventListener('keydown', (event) => {
  // Escape does not throw away a description being written.
  if (event.key === 'Escape' && (view === 'menu' || view === 'saved')) show('button')
})
// A click back in the application closes the menu; a report stays open while the tester looks.
window.addEventListener('blur', () => {
  if (view === 'menu') show('button')
})

// ── Button: click to open, drag to move ─────────────────────────────────────────

function applyAnchor(anchor: OverlayAnchor): void {
  document.body.classList.toggle('left', anchor.side === 'left')
  document.body.classList.toggle('top', anchor.y < 0.5)
}

interface Press {
  x: number
  y: number
  lastX: number
  lastY: number
  /** The button's place in the view when pressed. */
  rect: DOMRect
  /** The button's place in the window, once the view covers it. */
  origin?: { left: number; top: number }
  starting?: boolean
  released?: boolean
}

let press: Press | undefined

toggle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || view !== 'button') return
  press = { x: event.screenX, y: event.screenY, lastX: event.screenX, lastY: event.screenY, rect: toggle.getBoundingClientRect() }
  toggle.setPointerCapture(event.pointerId)
})

function moveTo(current: Press): void {
  if (!current.origin) return
  toggle.style.left = `${current.origin.left + current.lastX - current.x}px`
  toggle.style.top = `${current.origin.top + current.lastY - current.y}px`
}

window.addEventListener('pointermove', (event) => {
  const current = press
  if (!current) return
  current.lastX = event.screenX
  current.lastY = event.screenY
  if (current.origin) return moveTo(current)
  if (current.starting || Math.hypot(current.lastX - current.x, current.lastY - current.y) < DRAG_THRESHOLD) return
  current.starting = true
  void window.overlay.drag().then((from) => {
    current.origin = { left: from.x + current.rect.left, top: from.y + current.rect.top }
    document.body.classList.add('dragging')
    moveTo(current)
    if (current.released) void finish(current)
  })
})

async function finish(current: Press): Promise<void> {
  if (!current.origin) return
  const x = current.origin.left + current.lastX - current.x + toggle.offsetWidth / 2
  const y = current.origin.top + current.lastY - current.y + toggle.offsetHeight / 2
  const anchor = await window.overlay.drop(x, y)
  document.body.classList.remove('dragging')
  toggle.style.left = ''
  toggle.style.top = ''
  applyAnchor(anchor)
}

function release(): void {
  const current = press
  if (!current) return
  press = undefined
  current.released = true
  if (!current.starting) show('menu')
  else if (current.origin) void finish(current)
  // Otherwise the drag is still starting: it finishes as soon as the view has grown.
}

window.addEventListener('pointerup', release)
toggle.addEventListener('lostpointercapture', release)
window.addEventListener('blur', release)
// A keyboard press on the button is a click with no pointer.
toggle.addEventListener('click', (event) => {
  if (event.detail === 0) show('menu')
})

void window.overlay.info().then(({ label, anchor }) => {
  for (const el of document.querySelectorAll('[data-label]')) el.textContent = label
  applyAnchor(anchor)
})
