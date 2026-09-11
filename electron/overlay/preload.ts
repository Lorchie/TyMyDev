import { contextBridge, ipcRenderer } from 'electron'

// The overlay page's bridge, sandboxed like TryMyDev's own: it only reaches the channels
// its view listens to (attach.ts).
contextBridge.exposeInMainWorld('overlay', {
  info: () => ipcRenderer.invoke('overlay:info'),
  resize: (width: number, height: number, open: boolean) => ipcRenderer.send('overlay:resize', { width, height }, open),
  drag: () => ipcRenderer.invoke('overlay:drag'),
  drop: (x: number, y: number) => ipcRenderer.invoke('overlay:drop', { x, y }),
  report: {
    start: () => ipcRenderer.invoke('overlay:report:start'),
    preview: (description: string) => ipcRenderer.invoke('overlay:report:preview', description),
    save: (description: string, screenshot: boolean) =>
      ipcRenderer.invoke('overlay:report:save', { description, screenshot }),
    show: () => ipcRenderer.invoke('overlay:report:show'),
    close: () => ipcRenderer.send('overlay:report:close')
  }
})
