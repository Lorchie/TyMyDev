import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { cudaIndex } from './machine'
import type { Manifest, StartSpec, Step } from './types'

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { node?: string }
}

interface PythonProject {
  install: Step[]
  /** Files whose hash decides when the environment is rebuilt. */
  keys: string[]
}

const PYTHON_ENTRIES = ['main.py', 'app.py', 'server.py']
const TORCH_PACKAGES = ['torch', 'torchvision', 'torchaudio']

function readText(checkout: string, file: string): string | undefined {
  try {
    return readFileSync(join(checkout, file), 'utf-8')
  } catch {
    return undefined
  }
}

function readPackage(checkout: string): PackageJson | undefined {
  const text = readText(checkout, 'package.json')
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as PackageJson
  } catch {
    return undefined
  }
}

/**
 * A best guess for projects that ship no manifest. It covers the common shapes —
 * an npm project, an Electron application, a Python application — and nothing
 * more: anything unusual is what the manifest is for.
 */
export function detectManifest(checkout: string, fallbackName: string): Manifest {
  const pkg = readPackage(checkout)
  const python = pythonProject(checkout)
  if (!pkg && !python) {
    throw new Error(
      'This project could not be recognised automatically.\n' +
        'Ask its developer for a manifest, or write one describing how to install, ' +
        'build and start it.'
    )
  }

  const install: Step[] = []
  const build: Step[] = []

  if (pkg) {
    if (!existsSync(join(checkout, 'package-lock.json'))) {
      // pnpm and yarn are not provided yet, and installing with npm would silently
      // resolve a different dependency tree than the project pins.
      const other = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].find((f) =>
        existsSync(join(checkout, f))
      )
      if (other) {
        throw new Error(
          `This project uses ${other.split('-')[0].replace('.lockb', '').replace('.lock', '')}, ` +
            'which is not supported yet.\n' +
            'Add a manifest describing its install and build commands.'
        )
      }
    }
    install.push({ run: 'npm install --dangerously-allow-all-scripts' })
    if (pkg.scripts?.build) build.push({ run: 'npm run build' })
  }
  if (python) install.push(...python.install)

  return {
    name: pkg?.name ?? fallbackName,
    // Passed as written: the Node runtime understands ranges such as ">=18".
    runtime: pkg ? { node: pkg.engines?.node } : {},
    install,
    build,
    start: startOf(checkout, pkg),
    cacheKeys: {
      ...(pkg ? { node: ['package-lock.json'] } : {}),
      ...(python ? { python: python.keys } : {})
    },
    source: 'detected'
  }
}

/** Requirement files first, then pyproject.toml, which uv reads the same way. */
function pythonProject(checkout: string): PythonProject | undefined {
  const file = ['requirements.txt', 'api/requirements.txt', 'pyproject.toml'].find((f) =>
    existsSync(join(checkout, f))
  )
  if (!file) return undefined

  const text = readText(checkout, file) ?? ''
  const torch = TORCH_PACKAGES.filter((name) =>
    file === 'pyproject.toml'
      ? new RegExp(`["']${name}(?![\\w-])`).test(text)
      : new RegExp(`^\\s*${name}(?![\\w-])`, 'm').test(text)
  )

  const install: Step[] = []
  if (torch.length > 0) {
    // On Windows PyPI only carries CPU builds of torch: take the GPU build where there is one.
    install.push({
      run: `pip install ${torch.join(' ')} --extra-index-url ${cudaIndex()}`,
      when: { gpu: 'nvidia' }
    })
  }
  install.push({ run: `pip install -r ${file}` })

  return { install, keys: [file, ...(existsSync(join(checkout, 'uv.lock')) ? ['uv.lock'] : [])] }
}

function startOf(checkout: string, pkg: PackageJson | undefined): StartSpec {
  if (pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron) return { mode: 'electron' }

  const entry = PYTHON_ENTRIES.find((f) => existsSync(join(checkout, f)))
  if (entry) return { mode: 'web', run: `python ${entry}` }
  if (existsSync(join(checkout, 'manage.py'))) {
    return { mode: 'web', run: 'python manage.py runserver 127.0.0.1:{port}', port: 8000 }
  }

  if (pkg?.scripts?.dev) return { mode: 'web', run: 'npm run dev' }
  if (pkg?.scripts?.start) return { mode: 'web', run: 'npm start' }
  if (pkg) return { mode: 'command', run: 'npm test' }

  throw new Error(
    'This Python project has no entry point TryMyDev recognises (main.py, app.py, server.py, manage.py).\n' +
      'Ask its developer for a manifest, or write one describing how to start it.'
  )
}
