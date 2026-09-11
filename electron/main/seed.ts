import { existsSync } from 'fs'
import { dirname, join, normalize } from 'path'
import { fileDigest, linkDir, writeJson } from './fsx'
import type { SeedSpec } from './types'

export interface SeedPlaces {
  checkout: string
  data: string
  shared: string
  short: string
  documents: string
  venvPython?: string
}

/** `{name}` or `{name:argument}`; validation refuses every name but the ones below. */
export const PLACEHOLDER = /\{([A-Za-z0-9]+)(?::([^{}]*))?\}/g
export const FOLDER_PLACEHOLDERS = ['data', 'shared', 'short', 'venv', 'documents']

/** Before every start: links are placed each time, files once unless marked `always`. */
export async function placeSeeds(seeds: SeedSpec[] | undefined, places: SeedPlaces): Promise<void> {
  for (const seed of seeds ?? []) {
    const target = join(places.data, seed.path)
    if (seed.link !== undefined) {
      await linkDir(target, await fill(seed.link, places))
    } else if (seed.always || !existsSync(target)) {
      writeJson(target, await fillJson(seed.json, places))
    }
  }
}

async function fillJson(value: unknown, places: SeedPlaces): Promise<unknown> {
  if (typeof value === 'string') return fill(value, places)
  if (Array.isArray(value)) return Promise.all(value.map((item) => fillJson(item, places)))
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await fillJson(item, places)] as const)
    )
    return Object.fromEntries(entries)
  }
  return value
}

/** A string starting with a folder is a path, and gets the separators of the platform. */
async function fill(text: string, places: SeedPlaces): Promise<string> {
  let out = ''
  let last = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, match.index) + (await valueOf(match[1], match[2], places))
    last = match.index + match[0].length
  }
  out += text.slice(last)
  return FOLDER_PLACEHOLDERS.some((name) => text.startsWith(`{${name}}`)) ? normalize(out) : out
}

async function valueOf(name: string, arg: string | undefined, places: SeedPlaces): Promise<string> {
  switch (name) {
    case 'data':
      return places.data
    case 'shared':
      return places.shared
    case 'short':
      return places.short
    case 'documents':
      return places.documents
    case 'venv':
      if (!places.venvPython) throw new Error('A seed uses {venv}, but the manifest prepares no Python environment.')
      // <venv>/Scripts/python.exe on Windows, <venv>/bin/python elsewhere.
      return dirname(dirname(places.venvPython))
    case 'sha256': {
      const file = join(places.checkout, arg ?? '')
      if (!existsSync(file)) throw new Error(`A seed needs the digest of ${arg}, which the checkout does not have.`)
      return fileDigest(file)
    }
    default:
      throw new Error(`Unknown placeholder in a seed: {${name}}`)
  }
}
