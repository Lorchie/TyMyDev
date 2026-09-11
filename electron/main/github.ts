import { readJson, writeJson } from './fsx'
import { download, request } from './network'
import { etagsPath } from './paths'
import { githubToken } from './settings'
import { PRODUCT, type Source } from './types'
import type { ParsedInput } from './source-url'

const API = 'https://api.github.com'
const UA = { 'User-Agent': PRODUCT.name.toLowerCase() }

interface EtagEntry {
  etag: string
  value: string
}

/**
 * Anonymous GitHub allows 60 calls an hour — one branch check each would lock the
 * app out at a handful of branches. Conditional requests fix that: a 304 costs
 * nothing against the limit, so re-checking an unchanged branch is free.
 */
function etags(): Record<string, EtagEntry> {
  return readJson<Record<string, EtagEntry>>(etagsPath(), {})
}

function rememberEtag(path: string, etag: string | null, value: string): void {
  if (!etag) return
  writeJson(etagsPath(), { ...etags(), [path]: { etag, value } })
}

/** Anonymous by default; the token saved in Settings raises the limit and opens private repositories. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = githubToken()
  return { ...UA, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
}

/** The error a failed response deserves — read from it, never by asking again. */
function failure(res: Response, path: string): Error {
  if (res.status === 401) {
    return new Error('GitHub rejected the token saved in Settings (expired or revoked). Replace it, or remove it.')
  }
  if (res.status === 404) {
    return new Error(
      `Not found on GitHub: ${path}\n` +
        'Check that the branch still exists, and that the repository is public — or readable ' +
        'with the token in Settings.'
    )
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
    const wait = Math.max(1, Math.ceil((reset - Date.now()) / 60000))
    return new Error(
      'GitHub rate limit reached (60 requests per hour without a token).\n' +
        `Try again in ${wait} minute(s), or add a GitHub token in Settings.`
    )
  }
  return new Error(`GitHub answered ${res.status} ${res.statusText} for ${path}`)
}

async function api(path: string): Promise<Response> {
  const res = await request(`${API}${path}`, { headers: headers() })
  if (!res.ok) throw failure(res, path)
  return res
}

/** Checks a token before it is kept: the hourly limit it grants, or why GitHub refused it. */
export async function rateLimit(token: string): Promise<number> {
  const res = await request(`${API}/rate_limit`, { headers: { ...UA, Authorization: `Bearer ${token}` } })
  if (res.status === 401) throw new Error('GitHub rejected this token (mistyped, expired or revoked).')
  if (!res.ok) throw failure(res, '/rate_limit')
  const json = (await res.json()) as { resources?: { core?: { limit?: number } } }
  return json.resources?.core?.limit ?? 0
}

/** A branch or pull request, and the application it belongs to. */
export interface Resolved {
  source: Source
  /** `owner/repo` at the root of the fork network: what identifies the application. */
  upstream: string
}

/** A PR URL resolves to the head repository — the fork, when the PR comes from one. */
async function resolvePull(owner: string, repo: string, pr: number): Promise<Resolved> {
  const json = (await (await api(`/repos/${owner}/${repo}/pulls/${pr}`)).json()) as {
    head?: { ref?: string; repo?: { owner?: { login?: string }; name?: string } }
    base?: { repo?: { full_name?: string } }
  }
  const head = json.head
  if (!head?.ref || !head.repo?.name || !head.repo.owner?.login) {
    throw new Error(`PR #${pr} exposes no source branch (fork deleted?).`)
  }
  return {
    source: { owner: head.repo.owner.login, repo: head.repo.name, ref: head.ref, pr },
    upstream: json.base?.repo?.full_name ?? `${owner}/${repo}`
  }
}

/** One call: the repository gives both its default branch and the root of its forks. */
export async function resolveSource(parsed: ParsedInput): Promise<Resolved> {
  if (parsed.pr) return resolvePull(parsed.owner, parsed.repo, parsed.pr)

  const json = (await (await api(`/repos/${parsed.owner}/${parsed.repo}`)).json()) as {
    full_name?: string
    default_branch?: string
    source?: { full_name?: string }
  }
  const ref = parsed.ref ?? json.default_branch
  if (!ref) throw new Error(`No default branch found for ${parsed.owner}/${parsed.repo}.`)
  return {
    source: { owner: parsed.owner, repo: parsed.repo, ref },
    upstream: json.source?.full_name ?? json.full_name ?? `${parsed.owner}/${parsed.repo}`
  }
}

/** Head commit of the ref. The whole cache hinges on this one value. */
export async function headSha(src: Source): Promise<string> {
  const path = `/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(src.ref)}`
  const known = etags()[path]

  const res = await request(`${API}${path}`, {
    headers: headers({
      Accept: 'application/vnd.github.sha',
      ...(known ? { 'If-None-Match': known.etag } : {})
    })
  })

  if (res.status === 304 && known) return known.value
  if (!res.ok) throw failure(res, path)
  const sha = (await res.text()).trim()
  // Anything else — a proxy's page, a cut answer — must never reach a URL or a path.
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`GitHub did not answer with a commit for ${src.owner}/${src.repo}@${src.ref}.`)
  }
  rememberEtag(path, res.headers.get('etag'), sha)
  return sha
}

export async function downloadTarball(
  src: Source,
  sha: string,
  dest: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await download(`${API}/repos/${src.owner}/${src.repo}/tarball/${sha}`, dest, {
    headers: headers(),
    signal,
    onProgress,
    accept: (res) => {
      if (!res.ok) throw new Error(`Could not download the sources (HTTP ${res.status}).`)
    }
  })
}
