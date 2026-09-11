import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validate } from '../manifest'
import { cudaIndex } from '../machine'
import { builtinFor, builtinProfiles } from './builtin'

describe('built-in profiles', () => {
  for (const [key, profile] of Object.entries(builtinProfiles())) {
    it(`${key} is a valid manifest keyed by its own repository`, () => {
      assert.equal(key, profile.repo?.toLowerCase())
      assert.equal(profile.source, 'builtin')
      assert.doesNotThrow(() => validate(JSON.stringify(profile), key))
    })
  }

  it('is found whatever the case of the address', () => {
    assert.equal(builtinFor('COMFY-ORG/comfyui')?.name, 'ComfyUI')
    assert.equal(builtinFor('LightningPixel/Modly')?.name, 'Modly')
  })

  it('is not found under a fork name or a former name', () => {
    assert.equal(builtinFor('someone/modly'), undefined)
    assert.equal(builtinFor('comfyanonymous/ComfyUI'), undefined)
  })

  it('installs torch for the GPU before the ComfyUI requirements, on Python 3.13', () => {
    const comfy = builtinFor('Comfy-Org/ComfyUI')
    const install = comfy?.install ?? []
    assert.equal(comfy?.runtime?.python, '3.13')
    assert.deepEqual(install[0]?.when, { gpu: 'nvidia' })
    assert.equal(install[0]?.run, `pip install torch torchvision torchaudio --extra-index-url ${cudaIndex()}`)
    assert.match(cudaIndex(), /^https:\/\/download\.pytorch\.org\/whl\/cu\d+$/)
    assert.deepEqual(install[1]?.when, { gpu: 'amd', platform: 'linux' })
    assert.match(install[1]?.run ?? '', /--index-url https:\/\/download\.pytorch\.org\/whl\/rocm/)
    assert.equal(install.at(-1)?.run, 'pip install -r requirements.txt')
  })

  it('starts ComfyUI on the GPU it installed torch for, and in CPU mode otherwise', () => {
    const start = builtinFor('Comfy-Org/ComfyUI')?.start
    if (!Array.isArray(start)) throw new Error('ComfyUI has one start per kind of machine')
    assert.deepEqual(
      start.map((variant) => variant.when),
      [{ gpu: 'nvidia' }, { gpu: 'amd', platform: 'linux' }, undefined]
    )
    assert.match((start.at(-1) as { run: string }).run, /^python main\.py --cpu --port \{port\}$/)
  })

  it('lets the Modly install scripts run and shares its embedded Python', () => {
    const modly = builtinFor('lightningpixel/modly')
    assert.match(modly?.install?.[0]?.run ?? '', /--dangerously-allow-all-scripts/)
    assert.deepEqual(modly?.share, [{ path: 'resources/python-embed' }])
  })

  it('prepares the Python of Modly itself, so a branch never reaches the environment of an installed Modly', () => {
    const modly = builtinFor('lightningpixel/modly')
    const seed = modly?.seed ?? []
    const settings = seed.find((s) => s.path === 'settings.json')?.json as Record<string, string>

    assert.equal(modly?.runtime?.python, '3.11')
    assert.equal(modly?.install?.at(-1)?.run, 'pip install pip -r api/requirements.txt')
    assert.equal(settings.dependenciesDir, '{data}/dependencies')
    assert.equal(settings.modelsDir, '{documents}/Modly/models')
    assert.deepEqual(seed.find((s) => s.path === 'dependencies/venv'), { path: 'dependencies/venv', link: '{venv}' })
    assert.deepEqual(seed.find((s) => s.path === 'python_setup.json'), {
      path: 'python_setup.json',
      json: { version: 3, requirementsHash: '{sha256:api/requirements.txt}' },
      always: true
    })
  })

  it("uses the installed Modly's extensions and TryMyDev's workspace and workflows, each switchable", () => {
    const modly = builtinFor('lightningpixel/modly')
    const file = '{appData}/Modly/settings.json'
    assert.deepEqual(modly?.folders, [
      {
        id: 'extensions',
        label: 'Extensions',
        own: '{short}/ext',
        installed: { file, key: 'extensionsDir', usual: '{documents}/Modly/extensions' },
        use: 'installed'
      },
      {
        id: 'workspace',
        label: 'Workspace',
        own: '{shared}/workspace',
        installed: { file, key: 'workspaceDir', usual: '{documents}/Modly/workspace' },
        use: 'own'
      },
      {
        id: 'workflows',
        label: 'Workflows',
        own: '{shared}/workflows',
        installed: { file, key: 'workflowsDir', usual: '{documents}/Modly/workflows' },
        use: 'own'
      }
    ])
    assert.deepEqual(modly?.seed?.find((s) => s.merge), {
      path: 'settings.json',
      json: { extensionsDir: '{folder:extensions}', workspaceDir: '{folder:workspace}', workflowsDir: '{folder:workflows}' },
      merge: true
    })
    const once = modly?.seed?.find((s) => s.path === 'settings.json' && !s.merge)?.json as Record<string, string>
    assert.deepEqual(Object.keys(once), ['modelsDir', 'dependenciesDir'], 'folders are set by the merged keys only')
  })
})
