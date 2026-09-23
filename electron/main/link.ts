import { randomBytes, timingSafeEqual } from 'crypto'
import { rmSync } from 'fs'
import { createServer, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentLinkInfo, AgentRequest, AgentTarget } from '../overlay/agent'

/** How an agent's requests reach one running application, in TryMyDev or in its own process. */
export interface Channel {
  request<T = unknown>(request: AgentRequest): Promise<T>
  close(): void
}

/** A web application's window is TryMyDev's own: its requests are plain calls. */
export function localChannel(target: AgentTarget): Channel {
  return {
    request: <T>(request: AgentRequest) => target.handle(request) as Promise<T>,
    close: () => undefined
  }
}

const REQUEST_MS = 20_000
/** An application whose windows are not up yet, or still connecting, is waited for this long. */
const CONNECT_MS = 60_000

/**
 * A pipe for one launch of an Electron application: its path and secret go to the
 * application in its environment, and the first line it sends must be that secret — any
 * other program finding the pipe is disconnected. One connection only.
 */
export function pipeChannel(): { info: AgentLinkInfo; channel: Channel } {
  const secret = randomBytes(32).toString('hex')
  const name = `trymydev-${randomBytes(8).toString('hex')}`
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)

  let socket: Socket | undefined
  let closed = false
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  const waiting: Array<() => void> = []

  const server = createServer((incoming) => {
    if (socket) return incoming.destroy()
    incoming.setEncoding('utf-8')
    let buffer = ''
    let trusted = false
    incoming.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!trusted) {
          if (!sameSecret(line, secret)) return void incoming.destroy()
          trusted = true
          socket = incoming
          server.close()
          for (const wake of waiting.splice(0)) wake()
          continue
        }
        settle(line)
      }
    })
    incoming.on('error', () => undefined)
    incoming.on('close', () => {
      if (socket !== incoming) return
      socket = undefined
      closed = true
      for (const { reject } of pending.values()) reject(new Error('The application closed its connection: it has probably quit.'))
      pending.clear()
    })
  })
  server.on('error', () => undefined)
  server.listen(pipe)

  const settle = (line: string): void => {
    try {
      const { id, result, error } = JSON.parse(line) as { id: number; result?: unknown; error?: string }
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      if (error !== undefined) waiter.reject(new Error(error))
      else waiter.resolve(result)
    } catch {
      /* not a message of ours */
    }
  }

  const connected = (): Promise<Socket> => {
    if (socket) return Promise.resolve(socket)
    if (closed) return Promise.reject(new Error('The application is no longer connected.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The application did not connect to TryMyDev: its tools overlay may have failed to start (see its log).')),
        CONNECT_MS
      )
      waiting.push(() => {
        clearTimeout(timer)
        if (socket) resolve(socket)
        else reject(new Error('The application is no longer connected.'))
      })
    })
  }

  const channel: Channel = {
    async request<T>(request: AgentRequest): Promise<T> {
      const link = await connected()
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The application did not answer within ${REQUEST_MS / 1000} s: it may be busy or frozen.`))
        }, REQUEST_MS)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value as T)
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          }
        })
        link.write(`${JSON.stringify({ id, request })}\n`)
      })
    },
    close() {
      closed = true
      server.close()
      const open = socket
      socket = undefined
      open?.destroy()
      for (const { reject } of pending.values()) reject(new Error('The application is no longer connected.'))
      pending.clear()
      for (const wake of waiting.splice(0)) wake()
      if (process.platform !== 'win32') rmSync(pipe, { force: true })
    }
  }
  return { info: { pipe, secret }, channel }
}

function sameSecret(line: string, secret: string): boolean {
  try {
    const hello = (JSON.parse(line) as { hello?: unknown }).hello
    if (typeof hello !== 'string') return false
    const a = Buffer.from(hello)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}
