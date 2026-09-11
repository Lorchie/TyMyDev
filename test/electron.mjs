import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Just enough of Electron for the main-process modules to run under `node --test`. */
export const app = {
  getPath: () => process.env.TRYMYDEV_USER_DATA ?? join(tmpdir(), 'trymydev-test'),
  getAppPath: () => process.env.TRYMYDEV_APP_PATH ?? process.cwd(),
  getVersion: () => '0.0.0-test',
  getLocale: () => 'en-US',
  getGPUInfo: () =>
    Promise.resolve({
      gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2c05, deviceString: 'NVIDIA GeForce RTX 5070', driverVersion: '32.0.15.9186' }]
    }),
  get isPackaged() {
    return process.env.TRYMYDEV_PACKAGED === '1'
  }
}

/** A captured page: a few bytes standing for a PNG. */
const fakeImage = {
  isEmpty: () => false,
  toPNG: () => Buffer.from('fake-png'),
  resize: () => ({ toDataURL: () => 'data:image/png;base64,ZmFrZS1wbmc=' })
}

class WebContents {
  static nextId = 1

  constructor() {
    this.id = WebContents.nextId++
    this.listeners = {}
    this.openHandler = undefined
    this.focused = 0
    this.closed = false
    this.loading = false
    /** Scripts run in isolated worlds, and what the page answers them. */
    this.scripts = []
    this.isolated = () => undefined
    /** Channels scoped to this page, like `webContents.ipc`. */
    this.ipc = {
      handlers: {},
      listeners: {},
      handle: (channel, handler) => {
        this.ipc.handlers[channel] = handler
      },
      on: (channel, listener) => {
        this.ipc.listeners[channel] = listener
      }
    }
  }

  setWindowOpenHandler(handler) {
    this.openHandler = handler
  }

  on(event, listener) {
    ;(this.listeners[event] ??= []).push(listener)
  }

  emit(event, ...args) {
    for (const listener of this.listeners[event] ?? []) listener(...args)
  }

  loadURL(url) {
    this.url = url
    return Promise.resolve()
  }

  loadFile(path) {
    this.file = path
    return Promise.resolve()
  }

  focus() {
    this.focused++
  }

  isLoading() {
    return this.loading
  }

  executeJavaScriptInIsolatedWorld(world, scripts) {
    const code = scripts[0].code
    this.scripts.push({ world, code })
    try {
      return Promise.resolve(this.isolated(code))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  capturePage() {
    return Promise.resolve(fakeImage)
  }

  close() {
    this.closed = true
    this.emit('destroyed')
  }

  isDestroyed() {
    return this.closed
  }

  send() {}
}

export class BrowserWindow {
  static opened = []

  constructor(options) {
    this.options = options
    this.destroyed = false
    this.listeners = {}
    this.webContents = new WebContents()
    this.contentSize = [options?.width ?? 800, options?.height ?? 600]
    this.contentView = {
      children: [],
      addChildView: (view) => this.contentView.children.push(view)
    }
    BrowserWindow.opened.push(this)
  }

  loadURL(url) {
    this.url = url
    return Promise.resolve()
  }

  setMenuBarVisibility() {}

  getContentSize() {
    return this.contentSize
  }

  getBounds() {
    return { x: 0, y: 0, width: this.contentSize[0], height: this.contentSize[1] }
  }

  on(event, listener) {
    ;(this.listeners[event] ??= []).push(listener)
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.listeners[event] = this.listeners[event].filter((l) => l !== wrapped)
      listener(...args)
    }
    this.on(event, wrapped)
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners[event] ?? [])]) listener(...args)
  }

  isDestroyed() {
    return this.destroyed
  }

  /** Like Electron, a destroyed window throws when it is touched again. */
  destroy() {
    if (this.destroyed) throw new Error('Object has been destroyed')
    this.destroyed = true
    this.emit('closed')
  }
}

export class WebContentsView {
  static opened = []

  constructor(options) {
    this.options = options
    this.webContents = new WebContents()
    this.bounds = undefined
    this.background = undefined
    WebContentsView.opened.push(this)
  }

  setBounds(bounds) {
    this.bounds = bounds
  }

  setBackgroundColor(color) {
    this.background = color
  }
}

export const shell = {
  /** Every address handed to the browser, and every shortcut written. */
  opened: [],
  shortcuts: [],
  /** Files shown in their folder. */
  shown: [],
  showItemInFolder(path) {
    shell.shown.push(path)
  },
  openExternal(url) {
    shell.opened.push(url)
    return Promise.resolve()
  },
  writeShortcutLink(path, operation, details) {
    shell.shortcuts.push({ path, operation, details })
    return true
  }
}

/** Chromium's fetch, played by the global one — which the tests replace to fake GitHub. */
export const net = {
  fetch: (input, init) => globalThis.fetch(input, init)
}

function fakeSession(name) {
  return {
    name,
    cleared: 0,
    proxyRule: 'DIRECT',
    resolveProxy() {
      return Promise.resolve(this.proxyRule)
    },
    requestHandler: undefined,
    checkHandler: undefined,
    setPermissionRequestHandler(handler) {
      this.requestHandler = handler
    },
    setPermissionCheckHandler(handler) {
      this.checkHandler = handler
    },
    clearStorageData() {
      this.cleared++
      return Promise.resolve()
    }
  }
}

const partitions = new Map()

export const session = {
  defaultSession: fakeSession(''),
  fromPartition(name) {
    if (!partitions.has(name)) partitions.set(name, fakeSession(name))
    return partitions.get(name)
  }
}

export const ipcMain = {
  handlers: new Map(),
  handle(channel, handler) {
    ipcMain.handlers.set(channel, handler)
  }
}

export const clipboard = {
  text: '',
  writeText(text) {
    clipboard.text = text
  }
}

/** Reversible stand-in for the operating system's encryption. */
export const safeStorage = {
  isEncryptionAvailable: () => process.env.TRYMYDEV_NO_ENCRYPTION !== '1',
  getSelectedStorageBackend: () => process.env.TRYMYDEV_STORAGE_BACKEND ?? 'gnome_libsecret',
  encryptString: (text) => Buffer.from(`sealed:${text}`, 'utf-8'),
  decryptString: (buffer) => {
    const text = buffer.toString('utf-8')
    if (!text.startsWith('sealed:')) throw new Error('Error while decrypting the ciphertext')
    return text.slice('sealed:'.length)
  }
}

/** The save dialog answers with `savePath`, or is cancelled when there is none. */
export const dialog = {
  savePath: undefined,
  /** The folder picker answers with `openPath`, or is cancelled when there is none. */
  openPath: undefined,
  asked: [],
  showSaveDialog(window, options) {
    dialog.asked.push(options)
    return Promise.resolve(dialog.savePath ? { canceled: false, filePath: dialog.savePath } : { canceled: true })
  },
  showOpenDialog(window, options) {
    dialog.asked.push(options ?? window)
    return Promise.resolve(dialog.openPath ? { canceled: false, filePaths: [dialog.openPath] } : { canceled: true, filePaths: [] })
  }
}

export const screen = {
  getDisplayMatching: () => ({ scaleFactor: 1.5 })
}

export default {
  app,
  BrowserWindow,
  WebContentsView,
  shell,
  session,
  ipcMain,
  clipboard,
  safeStorage,
  net,
  dialog,
  screen
}
