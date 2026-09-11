import { cudaIndex, ROCM_INDEX } from '../machine'
import type { Manifest } from '../types'

/**
 * Profiles shipped with the application, for projects whose maintainers have not
 * written a manifest yet. They are ordinary manifests — nothing here is special
 * cased anywhere else in the code. Built when asked for: the torch build they install
 * depends on the GPU of the machine.
 */
const PROFILES: Record<string, () => Manifest> = {
  'lightningpixel/modly': () => ({
    name: 'Modly',
    repo: 'lightningpixel/modly',
    // Python 3.11: the version of the standalone Python Modly ships.
    runtime: { node: '22', python: '3.11' },
    install: [
      { run: 'npm install --dangerously-allow-all-scripts' },
      // Ships its own standalone Python; the script is a no-op once the copy exists.
      { run: 'node scripts/download-python-embed.js' },
      // What Modly's first-run screen installs, here once per requirements file. pip
      // itself too: extensions install their packages with `python -m pip`.
      { run: 'pip install pip -r api/requirements.txt' }
    ],
    build: [{ run: 'npm run build' }],
    start: { mode: 'electron' },
    share: [{ path: 'resources/python-embed' }],
    // Modly's first-run screen rewrites every data folder at once, then runs
    // `venv --clear` in the one it was given — Documents\Modly by default, which is where
    // an installed Modly keeps its own environment. A branch never shows that screen:
    // its settings point at its own folders, and the marker says setup is done.
    // Each folder is TryMyDev's own or the installed Modly's — where its settings say, else where
    // its first-run screen puts it — and the tester switches between them.
    folders: [
      {
        // The installed Modly's by default: each extension brings a torch environment, 50 GB for
        // some, so a set per TryMyDev fills the disk. TryMyDev's own is the short folder: an
        // extension's venv goes 214 characters deep, and Python on Windows stops at 260.
        id: 'extensions',
        label: 'Extensions',
        own: '{short}/ext',
        installed: { file: '{appData}/Modly/settings.json', key: 'extensionsDir', usual: '{documents}/Modly/extensions' },
        use: 'installed'
      },
      // Generations and workflows are TryMyDev's by default, apart from an installed Modly's: a
      // branch changing their format must not reach them.
      {
        id: 'workspace',
        label: 'Workspace',
        own: '{shared}/workspace',
        installed: { file: '{appData}/Modly/settings.json', key: 'workspaceDir', usual: '{documents}/Modly/workspace' },
        use: 'own'
      },
      {
        id: 'workflows',
        label: 'Workflows',
        own: '{shared}/workflows',
        installed: { file: '{appData}/Modly/settings.json', key: 'workflowsDir', usual: '{documents}/Modly/workflows' },
        use: 'own'
      }
    ],
    seed: [
      {
        path: 'settings.json',
        json: {
          // Models are only read or downloaded into: an installed Modly's library is reused.
          modelsDir: '{documents}/Modly/models',
          dependenciesDir: '{data}/dependencies'
        }
      },
      // At every start, so a folder chosen later reaches branches created before.
      {
        path: 'settings.json',
        json: {
          extensionsDir: '{folder:extensions}',
          workspaceDir: '{folder:workspace}',
          workflowsDir: '{folder:workflows}'
        },
        merge: true
      },
      { path: 'dependencies/venv', link: '{venv}' },
      // version is SETUP_VERSION in Modly's electron/main/python-setup.ts.
      {
        path: 'python_setup.json',
        json: { version: 3, requirementsHash: '{sha256:api/requirements.txt}' },
        always: true
      }
    ],
    cacheKeys: { node: ['package-lock.json'], python: ['api/requirements.txt'] },
    source: 'builtin'
  }),

  // Moved from comfyanonymous/ComfyUI; GitHub redirects the old address, so both
  // resolve to this upstream.
  'comfy-org/comfyui': () => ({
    name: 'ComfyUI',
    repo: 'Comfy-Org/ComfyUI',
    // The version ComfyUI's own portable build ships.
    runtime: { python: '3.13' },
    install: [
      // ComfyUI's own instructions: torch from the PyTorch index of the GPU first — on
      // Windows PyPI only carries CPU builds — then the rest.
      {
        run: `pip install torch torchvision torchaudio --extra-index-url ${cudaIndex()}`,
        when: { gpu: 'nvidia' }
      },
      {
        run: `pip install torch torchvision torchaudio --index-url ${ROCM_INDEX}`,
        when: { gpu: 'amd', platform: 'linux' }
      },
      { run: 'pip install -r requirements.txt' }
    ],
    // Without a GPU build of torch, ComfyUI only starts in CPU mode.
    start: [
      { mode: 'web', run: 'python main.py --port {port}', port: 8188, when: { gpu: 'nvidia' } },
      { mode: 'web', run: 'python main.py --port {port}', port: 8188, when: { gpu: 'amd', platform: 'linux' } },
      { mode: 'web', run: 'python main.py --cpu --port {port}', port: 8188 }
    ],
    // Model libraries are tens of gigabytes and belong to the application, not to
    // one branch of it.
    share: [{ path: 'models' }, { path: 'output' }],
    cacheKeys: { python: ['requirements.txt'] },
    source: 'builtin'
  })
}

/** Every profile, keyed by its upstream repository in lowercase. */
export function builtinProfiles(): Record<string, Manifest> {
  return Object.fromEntries(Object.entries(PROFILES).map(([repo, profile]) => [repo, profile()]))
}

/** `repo` is the upstream `owner/repo`, so forks of a known project get its profile. */
export function builtinFor(repo: string): Manifest | undefined {
  return PROFILES[repo.toLowerCase()]?.()
}
