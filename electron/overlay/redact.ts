/**
 * Masks what a bug report must not carry. Applied when something is recorded, not when
 * the report is written, so nothing sensitive sits in memory longer than it has to.
 * Patterns only catch what they know: the tester still reads the report before sending it.
 */

export interface RedactContext {
  /** The tester's home folder, replaced by `~`. */
  home?: string
  /** The computer's name, which logs and prompts often print. */
  hostname?: string
}

const MASK = '[redacted]'

/** Credentials whose shape is known, whatever surrounds them. */
const TOKENS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
]

/** `Authorization: Bearer …`, `token=…`, `"password": "…"`, `GITHUB_TOKEN=…`: the name stays, the value goes. */
const NAMED_SECRET =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id|cookie|authorization)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi
/** Parameters of web addresses: tokens, e-mails and search terms travel there. */
const URL_QUERY = /\b((?:https?|wss?|ftp):\/\/[^\s?#"'<>]+)\?([^\s#"'<>]*)/gi
/** Punctuation that ends a sentence, not a query: `…?a=1: failed` keeps its colon. */
const TRAILING = /[.,:;!)\]]+$/
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
/** Somebody's folder, when it is not the tester's own. */
const USER_FOLDER = /([\\/])(Users|home)([\\/])(?!\[user\])[^\\/\s"'`:*?<>|]+/gi
/** Public IPv4 addresses; loopback and private ranges say nothing about anyone. */
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/** Only a real public address: `132.0.6834.83` is a Chrome version, and private ranges say nothing about anyone. */
function isPublicIp(ip: string): boolean {
  const [a, b, ...rest] = ip.split('.').map(Number)
  if ([a, b, ...rest].some((part) => part > 255)) return false
  return !(a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254))
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The home folder in every spelling a log may use: either slash, and any case on Windows. */
function homePattern(home: string): RegExp | undefined {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed.length < 3) return undefined
  const parts = trimmed.split(/[\\/]+/).filter(Boolean).map(escapeRegExp)
  // A home starting with a slash takes that one slash: `file:///home/me` keeps the others.
  const lead = /^[\\/]/.test(trimmed) ? '[\\\\/]' : ''
  return new RegExp(lead + parts.join('[\\\\/]+'), process.platform === 'win32' ? 'gi' : 'g')
}

export function redactText(text: string, context: RedactContext = {}): string {
  let out = text
  for (const token of TOKENS) out = out.replace(token, MASK)
  out = out
    .replace(AUTH_SCHEME, `$1 ${MASK}`)
    .replace(URL_CREDENTIALS, '$1[user]@')
    .replace(URL_QUERY, (_match, base: string, query: string) => `${base}?…${query.match(TRAILING)?.[0] ?? ''}`)
    .replace(NAMED_SECRET, `$1$2${MASK}`)
    .replace(EMAIL, '[email]')
  const home = context.home ? homePattern(context.home) : undefined
  if (home) out = out.replace(home, '~')
  out = out.replace(USER_FOLDER, '$1$2$3[user]')
  if (context.hostname && context.hostname.length >= 3) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(context.hostname)}\\b`, 'gi'), '[host]')
  }
  return out.replace(IPV4, (ip) => (isPublicIp(ip) ? '[ip]' : ip))
}

/**
 * An address the application went to: no credentials, no parameters, and a fragment only
 * when it looks like a route (`#/models`) rather than data (`#access_token=…`).
 */
export function redactUrl(url: string, context: RedactContext = {}): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return redactText(url, context)
  }
  const hash = parsed.hash && !/[=&]/.test(parsed.hash) && parsed.hash.length <= 80 ? parsed.hash : parsed.hash ? '#…' : ''
  const query = parsed.search ? '?…' : ''
  if (parsed.protocol === 'file:') {
    // The path is masked on its own, then the address rebuilt: `/home/me/app` becomes `~/app`,
    // and `file:///~/app` on every system.
    const path = redactText(decoded(parsed.pathname), context)
    return redactText(`file://${path.startsWith('/') ? '' : '/'}${path}${query}${hash}`, context)
  }
  return redactText(`${parsed.protocol}//${parsed.host}${decoded(parsed.pathname)}${query}${hash}`, context)
}
