import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Sandboxed: only contextBridge and ipcRenderer are available here, and nothing else
// should be — everything that touches the system goes through the main process.

const on = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('trymydev', {
  platform: process.platform,
  list: () => ipcRenderer.invoke('apps:list'),
  addApp: (input: string, manifest?: string) => ipcRenderer.invoke('apps:add', input, manifest),
  removeApp: (appId: string) => ipcRenderer.invoke('apps:remove', appId),
  folders: (appId: string) => ipcRenderer.invoke('apps:folders', appId),
  chooseFolder: (appId: string, id: string) => ipcRenderer.invoke('apps:chooseFolder', appId, id),
  useFolder: (appId: string, id: string, which: string) => ipcRenderer.invoke('apps:useFolder', appId, id, which),
  addBranch: (appId: string, input: string) => ipcRenderer.invoke('branches:add', appId, input),
  removeBranch: (key: string) => ipcRenderer.invoke('branches:remove', key),
  start: (key: string) => ipcRenderer.invoke('branches:start', key),
  cancel: (key: string) => ipcRenderer.invoke('branches:cancel', key),
  refresh: () => ipcRenderer.invoke('branches:refresh'),
  shortcut: (key: string) => ipcRenderer.invoke('branches:shortcut', key),
  approve: (appId: string, hash: string, key: string) =>
    ipcRenderer.invoke('manifest:approve', appId, hash, key),
  usage: () => ipcRenderer.invoke('storage:usage'),
  prune: () => ipcRenderer.invoke('storage:prune'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setGithubToken: (token: string | null) => ipcRenderer.invoke('settings:setGithubToken', token),
  setPreference: (name: string, value: boolean) => ipcRenderer.invoke('settings:setPreference', name, value),
  copyAgentCommand: () => ipcRenderer.invoke('settings:copyAgentCommand'),
  renewAgentToken: () => ipcRenderer.invoke('settings:renewAgentToken'),
  openLogs: (appId: string, key: string) => ipcRenderer.invoke('branches:openLogs', appId, key),
  openAppLog: () => ipcRenderer.invoke('app:openLog'),
  reportError: (message: string) => ipcRenderer.invoke('app:reportError', message),
  showItem: (path: string) => ipcRenderer.invoke('shell:showItem', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  copy: (text: string) => ipcRenderer.invoke('app:copy', text),
  onStep: (cb: (p: unknown) => void) => on('job:step', cb),
  onLog: (cb: (p: unknown) => void) => on('job:log', cb),
  onError: (cb: (p: unknown) => void) => on('job:error', cb),
  onApproval: (cb: (p: unknown) => void) => on('job:approval', cb),
  onUpdated: (cb: (p: unknown) => void) => on('branch:updated', cb),
  onRemote: (cb: (p: unknown) => void) => on('branch:remote', cb)
})
