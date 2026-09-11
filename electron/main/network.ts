import { net, session } from 'electron'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export interface RequestOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** How long the answer may take. */
  answerMs?: number
  /** How long a download may go without receiving anything. */
  idleMs?: number
}

const ANSWER_MS = 30_000
const IDLE_MS = 60_000
/** Statuses whose response has no body — `new Response` refuses one. */
const NO_BODY = new Set([101, 103, 204, 205, 304])

/**
 * One signal for a request: the job's own, and a timer that `arm` restarts. A request
 * never waits forever on a connection that went silent — a cancelled job's neither.
 */
function deadline(
  options: RequestOptions,
  host: string
): { signal: AbortSignal; arm: (ms: number, what: string) => void; done: () => void } {
  const controller = new AbortController()
  const cancel = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) cancel()
  options.signal?.addEventListener('abort', cancel, { once: true })
  let timer: NodeJS.Timeout | undefined
  return {
    signal: controller.signal,
    arm: (ms, what) => {
      clearTimeout(timer)
      timer = setTimeout(
        () => controller.abort(new Error(`${host} ${what} for ${Math.round(ms / 1000)} s — the connection was dropped.`)),
        ms
      )
    },
    done: () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
  }
}

/** Chromium's own cache stays out of it: a branch check must reach GitHub, conditionally. */
function fetchInit(options: RequestOptions, signal: AbortSignal): Parameters<typeof net.fetch>[1] {
  return { headers: options.headers, signal, cache: 'no-store' } as Parameters<typeof net.fetch>[1]
}

/** The reason of our own timer, rather than the bare abort error it causes. */
function reasonOf(err: unknown, signal: AbortSignal, options: RequestOptions): unknown {
  return signal.reason instanceof Error && !options.signal?.aborted ? signal.reason : err
}

/**
 * Requests go through Chromium's network stack: the proxy, the PAC file and the
 * certificates configured in the system — a company's own included — apply as they do
 * in the browser. Node's fetch knows none of them. The body is read before returning,
 * within the same deadline; for large ones, see `download`.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const limit = deadline(options, new URL(url).host)
  limit.arm(options.answerMs ?? ANSWER_MS, 'did not answer')
  try {
    const res = await net.fetch(url, fetchInit(options, limit.signal))
    const body = NO_BODY.has(res.status) ? null : await res.arrayBuffer()
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (err) {
    throw reasonOf(err, limit.signal, options)
  } finally {
    limit.done()
  }
}

/**
 * Saves a response body to a file. Its status is checked by `accept` first, which throws
 * the error the caller wants to show; the transfer fails once nothing arrives for a while.
 */
export async function download(
  url: string,
  dest: string,
  options: RequestOptions & {
    accept: (res: Response) => void
    onProgress?: (received: number, total: number) => void
  }
): Promise<void> {
  const limit = deadline(options, new URL(url).host)
  limit.arm(options.answerMs ?? ANSWER_MS, 'did not answer')
  try {
    const res = await net.fetch(url, fetchInit(options, limit.signal))
    try {
      options.accept(res)
    } catch (err) {
      await res.body?.cancel().catch(() => undefined)
      throw err
    }
    if (!res.body) throw new Error(`Empty answer from ${new URL(url).host}.`)

    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0
    const idle = options.idleMs ?? IDLE_MS
    limit.arm(idle, 'sent nothing')
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      limit.arm(idle, 'sent nothing')
      received += chunk.length
      options.onProgress?.(received, total)
    })
    await pipeline(body, createWriteStream(dest))
  } catch (err) {
    throw reasonOf(err, limit.signal, options)
  } finally {
    limit.done()
  }
}

/** `PROXY host:port; DIRECT` as Chromium resolves it → `http://host:port`; nothing when direct. */
export function proxyUrl(rule: string): string | undefined {
  const match = (rule.split(';')[0] ?? '').trim().match(/^(PROXY|HTTPS)\s+(\S+)$/i)
  if (!match) return undefined
  return `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
}

/**
 * The proxy the system would use for package downloads — set by hand, by a PAC file or
 * by WPAD. SOCKS proxies are left out: npm cannot use them.
 */
export async function systemProxy(): Promise<string | undefined> {
  try {
    return proxyUrl(await session.defaultSession.resolveProxy('https://registry.npmjs.org/'))
  } catch {
    return undefined
  }
}
