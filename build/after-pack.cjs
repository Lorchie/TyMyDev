// electron-builder hook. npm ships beside app.asar exactly as npm publishes it: packaged
// as a dependency, its bundled modules would be hoisted into the archive, where the real
// Node that runs npm cannot read them.
const { execFileSync } = require('node:child_process')
const { cpSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const from = join(context.packager.projectDir, 'node_modules', 'npm')
  const to = join(context.packager.getResourcesDir(context.appOutDir), 'npm')
  cpSync(from, to, { recursive: true, dereference: true })

  // Without an Apple Developer ID the app is not signed, and Apple Silicon refuses to launch
  // an unsigned app at all: an ad-hoc signature, made after npm was copied in, lets it start
  // once the tester has allowed it (right-click > Open).
  if (context.electronPlatformName === 'darwin') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  }
}
