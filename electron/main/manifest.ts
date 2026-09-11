import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { detectManifest } from './detect'
import { hashString } from './fsx'
import { machine, matches } from './machine'
import { builtinFor } from './profiles/builtin'
import { FOLDER_PLACEHOLDERS, PLACEHOLDER, ROOT_PLACEHOLDERS } from './seed'
import {
  PRODUCT,
  type App,
  type Approval,
  type Manifest,
  type Source,
  type StartSpec,
  type Step
} from './types'

/**
 * Where a manifest comes from, in order:
 *
 *   1. the repository, at the commit being tested — always right, and a branch
 *      that changes its own build is exactly what a tester needs to try;
 *   2. the one the developer handed over — works on projects that have never
 *      heard of this tool, which is most of them;
 *   3. a profile shipped with the application, looked up by the upstream
 *      repository so its forks and pull requests get it too;
 *   4. detection, for ordinary npm and Python projects.
 */
export function resolveManifest(checkout: string, app: App, src: Source): Manifest {
  const fromRepo = readRepoManifest(checkout)
  if (fromRepo) return { ...fromRepo, source: 'repository' }
  if (app.manifest) return { ...app.manifest, source: 'provided' }

  const builtin = builtinFor(app.repo ?? `${src.owner}/${src.repo}`)
  if (builtin) return builtin

  return detectManifest(checkout, `${src.owner}/${src.repo}`)
}

function readRepoManifest(checkout: string): Manifest | undefined {
  const path = join(checkout, PRODUCT.manifestFile)
  if (!existsSync(path)) return undefined
  return validate(readFileSync(path, 'utf-8'), `${PRODUCT.manifestFile} of the repository`)
}

/** Parses and checks a manifest, with errors a developer can act on. */
export function validate(text: string, origin: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${origin} is not valid JSON: ${(err as Error).message}`)
  }
  const m = raw as Partial<Manifest>

  if (typeof m.name !== 'string' || m.name.trim() === '') {
    throw new Error(`${origin}: "name" is required.`)
  }
  const starts: unknown[] = Array.isArray(m.start) ? m.start : [m.start]
  if (!m.start || typeof m.start !== 'object' || starts.length === 0) {
    throw new Error(`${origin}: "start" is required (mode electron, web or command).`)
  }
  for (const [index, start] of starts.entries()) {
    const where = Array.isArray(m.start) ? `start[${index}]` : 'start'
    if (!start || typeof start !== 'object') throw new Error(`${origin}: "${where}" must be an object.`)
    const mode = (start as { mode?: string }).mode
    if (!['electron', 'web', 'command'].includes(mode ?? '')) {
      throw new Error(`${origin}: "${where}.mode" must be electron, web or command.`)
    }
    if (mode !== 'electron' && typeof (start as { run?: string }).run !== 'string') {
      throw new Error(`${origin}: "${where}.run" is required for mode ${mode}.`)
    }
    condition((start as { when?: unknown }).when, `${origin}: "${where}" when`)
  }
  for (const [field, steps] of [
    ['install', m.install],
    ['build', m.build]
  ] as const) {
    if (steps && !Array.isArray(steps)) throw new Error(`${origin}: "${field}" must be a list.`)
    for (const step of steps ?? []) {
      if (typeof (step as Step).run !== 'string') {
        throw new Error(`${origin}: every "${field}" entry needs a "run" string.`)
      }
      if ((step as Step).cwd !== undefined) inside((step as Step).cwd, `${origin}: "${field}" cwd`)
      condition((step as Step).when, `${origin}: "${field}" when`)
    }
  }
  if (m.share !== undefined) {
    if (!Array.isArray(m.share)) throw new Error(`${origin}: "share" must be a list.`)
    for (const share of m.share) {
      inside(share?.path, `${origin}: "share" path`)
      if (share.env !== undefined && typeof share.env !== 'string') {
        throw new Error(`${origin}: "share" env must be a variable name.`)
      }
    }
  }
  if (m.isolate !== undefined) {
    if (!Array.isArray(m.isolate)) throw new Error(`${origin}: "isolate" must be a list.`)
    for (const iso of m.isolate) {
      if (typeof iso?.env !== 'string' || iso.env === '') {
        throw new Error(`${origin}: every "isolate" entry needs an "env" name.`)
      }
      inside(iso.dir, `${origin}: "isolate" dir`)
    }
  }
  const folderIds = new Set<string>()
  if (m.folders !== undefined) {
    if (!Array.isArray(m.folders)) throw new Error(`${origin}: "folders" must be a list.`)
    for (const folder of m.folders) {
      if (typeof folder?.id !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(folder.id) || folderIds.has(folder.id)) {
        throw new Error(`${origin}: every folder needs its own "id", made of letters and digits.`)
      }
      folderIds.add(folder.id)
      const what = `${origin}: folder ${folder.id}`
      if (typeof folder.label !== 'string' || folder.label.trim() === '') throw new Error(`${what} needs a "label".`)
      rooted(folder.own, `${what}: "own"`, OWN_ROOTS)
      if (folder.installed !== undefined) {
        rooted(folder.installed?.file, `${what}: "installed.file"`)
        rooted(folder.installed.usual, `${what}: "installed.usual"`)
        if (typeof folder.installed.key !== 'string' || folder.installed.key === '') {
          throw new Error(`${what}: "installed.key" must name the key holding the path.`)
        }
      }
      if (folder.use !== 'own' && !(folder.use === 'installed' && folder.installed)) {
        throw new Error(`${what}: "use" must be "own", or "installed" with an "installed" folder.`)
      }
    }
  }
  if (m.seed !== undefined) {
    if (!Array.isArray(m.seed)) throw new Error(`${origin}: "seed" must be a list.`)
    for (const seed of m.seed) {
      inside(seed?.path, `${origin}: "seed" path`)
      const what = `${origin}: "seed" ${seed.path}`
      if ((seed.json === undefined) === (seed.link === undefined)) {
        throw new Error(`${what} needs either "json" or "link".`)
      }
      if (seed.always !== undefined && typeof seed.always !== 'boolean') {
        throw new Error(`${what}: "always" must be true or false.`)
      }
      if (seed.merge !== undefined) {
        if (typeof seed.merge !== 'boolean') throw new Error(`${what}: "merge" must be true or false.`)
        if (seed.merge && (seed.always || !seed.json || typeof seed.json !== 'object' || Array.isArray(seed.json))) {
          throw new Error(`${what}: "merge" needs "json" to be an object, and cannot go with "always".`)
        }
      }
      if (seed.link !== undefined) {
        // A link lands in a folder TryMyDev knows, never at an arbitrary place on the disk.
        const folder = typeof seed.link === 'string' ? seed.link.match(/^\{([a-z]+)\}(.*)$/) : null
        if (!folder || !FOLDER_PLACEHOLDERS.includes(folder[1]) || folder[2].split(/[\\/]+/).includes('..')) {
          throw new Error(`${what}: "link" must start with {${FOLDER_PLACEHOLDERS.join('}, {')}} and stay inside it.`)
        }
      }
      for (const text of strings(seed.link ?? seed.json)) placeholders(text, what, folderIds)
    }
  }
  const env: unknown = m.env
  if (
    env !== undefined &&
    (typeof env !== 'object' ||
      env === null ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`${origin}: "env" must map variable names to strings.`)
  }
  // The characters GitHub allows: the repository names a folder and an API path.
  if (m.repo !== undefined && (typeof m.repo !== 'string' || !/^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/.test(m.repo))) {
    throw new Error(`${origin}: "repo" must look like owner/name.`)
  }
  return m as Manifest
}

/**
 * A path a manifest points inside the project. Links are created there and whatever
 * stands in the way is deleted, so "", "." or ".." would take the checkout — or more —
 * with them.
 */
function inside(path: unknown, what: string): void {
  const parts =
    typeof path === 'string' ? path.split(/[\\/]+/).filter((p) => p !== '' && p !== '.') : []
  if (
    typeof path !== 'string' ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    parts.length === 0 ||
    parts.includes('..')
  ) {
    throw new Error(`${what} must be a relative path inside the project, not ${JSON.stringify(path)}.`)
  }
}

/** Every string inside a JSON value, however deep. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** A misspelt placeholder would reach the application as text, so each one is checked. */
function placeholders(text: string, what: string, folderIds: Set<string>): void {
  for (const [whole, name, arg] of text.matchAll(PLACEHOLDER)) {
    if (name === 'sha256' && arg !== undefined) {
      inside(arg, `${what}: the file of ${whole}`)
    } else if (name === 'folder' && arg !== undefined) {
      if (!folderIds.has(arg)) throw new Error(`${what}: ${whole} is not one of the manifest's "folders".`)
    } else if (arg !== undefined || !ROOT_PLACEHOLDERS.includes(name)) {
      throw new Error(
        `${what}: unknown placeholder ${whole} (${ROOT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}, {folder:id} or {sha256:file}).`
      )
    }
  }
}

/** Folders known for every branch of an application: where an installed copy's folders may be. */
const FOLDER_ROOTS = ['shared', 'short', 'documents', 'appData']
/** TryMyDev's own folders for an application. */
const OWN_ROOTS = ['shared', 'short']

/** A path starting in one of `roots`, and staying inside it. */
function rooted(path: unknown, what: string, roots: string[] = FOLDER_ROOTS): void {
  const match = typeof path === 'string' ? path.match(/^\{([A-Za-z]+)\}([^{}]*)$/) : null
  if (!match || !roots.includes(match[1]) || match[2].split(/[\\/]+/).includes('..')) {
    throw new Error(`${what} must start with {${roots.join('}, {')}} and stay inside it.`)
  }
}

const CONDITIONS = { platform: ['windows', 'macos', 'linux'], gpu: ['nvidia', 'amd', 'none'] } as const

/** A misspelt condition would silently run its step everywhere, so every part is checked. */
function condition(when: unknown, what: string): void {
  if (when === undefined) return
  if (typeof when !== 'object' || when === null || Array.isArray(when)) {
    throw new Error(`${what} must be an object with "platform" and/or "gpu".`)
  }
  for (const [field, value] of Object.entries(when)) {
    const allowed: readonly string[] | undefined = CONDITIONS[field as keyof typeof CONDITIONS]
    if (!allowed) throw new Error(`${what}: unknown condition "${field}" (platform or gpu).`)
    const values: unknown[] = Array.isArray(value) ? value : [value]
    if (values.length === 0 || values.some((v) => typeof v !== 'string' || !allowed.includes(v))) {
      throw new Error(`${what}.${field} must be ${allowed.join(', ')} or a list of them.`)
    }
  }
}

/** The steps of a list that run on this machine. */
export function stepsFor(steps: Step[] | undefined): Step[] {
  return (steps ?? []).filter((step) => matches(step.when))
}

/** The start used on this machine: the only one, or the first variant whose condition matches. */
export function startFor(m: Manifest): StartSpec {
  if (!Array.isArray(m.start)) return m.start
  const start = m.start.find((variant) => matches(variant.when))
  if (!start) {
    const { platform, gpu } = machine()
    throw new Error(`${m.name} has no start for this machine (${platform}, GPU: ${gpu}).`)
  }
  return start
}

/** Whether a manifest needs a runtime: asked for explicitly, or implied by its commands. */
export function wants(m: Manifest, kind: 'node' | 'python'): boolean {
  if (m.runtime?.[kind] !== undefined) return true
  const start = startFor(m)
  const lines = [...stepsFor(m.install), ...stepsFor(m.build)]
    .map((s) => s.run)
    .concat(start.mode === 'electron' ? 'electron' : start.run)
  const tool = kind === 'node' ? /^(npm|npx|node|electron)\b/ : /^(pip|pip3|python|python3|uv)\b/
  return lines.some((line) => tool.test(line))
}

/** Identity of a manifest's *behaviour*: what would run, not how it is formatted. */
export function manifestHash(m: Manifest): string {
  return hashString(
    JSON.stringify({
      install: m.install ?? [],
      build: m.build ?? [],
      start: m.start,
      share: m.share ?? [],
      isolate: m.isolate ?? [],
      env: m.env ?? {},
      runtime: m.runtime ?? {},
      // Only when present: approvals given before seeds existed stay valid.
      ...(m.seed ? { seed: m.seed } : {}),
      ...(m.folders ? { folders: m.folders } : {})
    })
  )
}

/** The commands that run on this machine, in order. */
export function commandsOf(m: Manifest): string[] {
  const start = startFor(m)
  const steps = [...stepsFor(m.install), ...stepsFor(m.build)].map((s) =>
    s.cwd ? `${s.run}    (in ${s.cwd})` : s.run
  )
  return [...steps, start.mode === 'electron' ? 'launch the Electron application' : start.run]
}

/** Everything besides commands that changes the disk or what the commands see. */
function settingsOf(m: Manifest): string[] {
  return [
    ...(m.share ?? []).map((s) => `shared by every branch: ${s.path}${s.env ? ` (${s.env})` : ''}`),
    ...(m.isolate ?? []).map((i) => `separate per branch: ${i.env} → ${i.dir}`),
    ...(m.folders ?? []).map((f) => {
      const installed = f.installed
        ? `the installed application's (${f.installed.key} in ${f.installed.file}, else ${f.installed.usual})`
        : undefined
      const first = f.use === 'installed' && installed ? `${installed}, else TryMyDev's ${f.own}` : `TryMyDev's ${f.own}`
      return `folder "${f.label}": ${first}${installed && f.use === 'own' ? `, or ${installed}` : ''} — you can switch`
    }),
    ...(m.seed ?? []).map((s) =>
      s.link !== undefined
        ? `link in the data folder: ${s.path} → ${s.link}`
        : s.merge
          ? `keys set in the data folder at every start: ${s.path} = ${JSON.stringify(s.json)}`
          : `file in the data folder, ${s.always ? 'at every start' : 'once'}: ${s.path} = ${JSON.stringify(s.json)}`
    ),
    ...Object.entries(m.env ?? {}).map(([name, value]) => `environment: ${name}=${value}`)
  ]
}

/**
 * What the tester is shown before anything from a manifest runs on their machine.
 * Nothing is hidden or shortened: a manifest is arbitrary commands, and the person
 * running them is often not the person who wrote them.
 */
export function approvalOf(app: App, m: Manifest, src: Source, warnings: string[] = []): Approval {
  const downloads: string[] = []
  if (wants(m, 'node')) downloads.push('Node.js runtime (~100 MB, once for every application)')
  if (wants(m, 'python')) downloads.push('Python runtime and uv (~150 MB, once for every application)')
  downloads.push(`Sources of ${src.owner}/${src.repo}`)

  const repo = `${src.owner}/${src.repo}`
  return {
    appId: app.id,
    appName: m.name,
    repo,
    upstream: app.repo,
    foreign: app.repo !== undefined && app.repo.toLowerCase() !== repo.toLowerCase(),
    manifestHash: manifestHash(m),
    source: m.source,
    commands: commandsOf(m),
    settings: settingsOf(m),
    downloads,
    warnings
  }
}
