import { hashString } from './fsx'
import type { Source } from './types'

export interface ParsedInput {
  owner: string
  repo: string
  /** Undefined when the input carries no ref — the default branch is resolved later. */
  ref?: string
  pr?: number
}

const OWNER_RE = '[A-Za-z0-9_.-]+'

/**
 * Accepts what a tester can realistically paste:
 *   https://github.com/owner/repo/tree/feat/some-branch
 *   https://github.com/owner/repo/pull/42
 *   https://github.com/owner/repo(.git)
 *   owner/repo@feat/some-branch   |   owner/repo
 */
export function parseInput(raw: string): ParsedInput {
  const input = raw.trim().replace(/\s+/g, '')
  if (input === '') throw new Error('Empty address.')

  const url = input.match(
    new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER_RE})/(${OWNER_RE}?)(?:\\.git)?(/.*)?$`)
  )
  if (url) {
    const owner = url[1]
    const repo = url[2].replace(/\.git$/, '')
    const rest = url[3] ?? ''

    const pr = rest.match(/^\/pull\/(\d+)/)
    if (pr) return { owner, repo, pr: Number(pr[1]) }

    const tree = rest.match(/^\/(?:tree|blob)\/(.+?)\/?$/)
    if (tree) return { owner, repo, ref: decodeURIComponent(tree[1]) }

    return { owner, repo }
  }

  const short = input.match(new RegExp(`^(${OWNER_RE})/(${OWNER_RE}?)(?:@(.+))?$`))
  if (short) {
    return { owner: short[1], repo: short[2].replace(/\.git$/, ''), ref: short[3] }
  }

  throw new Error(
    `Unrecognised address: ${raw}\n` +
      'Accepted examples:\n' +
      '  https://github.com/lightningpixel/modly/tree/feat/api-token-and-agent-guards\n' +
      '  https://github.com/owner/modly/pull/42\n' +
      '  owner/modly@my-branch'
  )
}

/**
 * Folder name of one branch of one application: its ref, for a person reading the disk,
 * and a hash of everything, for uniqueness — "fix/login" and "fix-login", or "Dev" and
 * "dev", stay apart. Kept short: Windows allows 260 characters per path, and builds copy
 * deep node_modules trees into the checkout.
 */
export function branchKey(appId: string, src: Source): string {
  const ref = src.ref
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 24)
    .replace(/[-.]+$/, '')
    .toLowerCase()
  const identity = `${appId}/${src.owner.toLowerCase()}/${src.repo.toLowerCase()}@${src.ref}`
  return `${ref || 'branch'}-${hashString(identity).slice(0, 8)}`
}
