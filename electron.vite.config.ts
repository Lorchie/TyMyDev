import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: {
          index: resolve('electron/main/index.ts'),
          // Preloaded into tested Electron applications.
          inject: resolve('electron/overlay/inject.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: {
          index: resolve('electron/preload/index.ts'),
          overlay: resolve('electron/overlay/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      rollupOptions: {
        input: { index: resolve('src/index.html'), overlay: resolve('src/overlay.html') }
      }
    },
    plugins: [react()]
  }
})
