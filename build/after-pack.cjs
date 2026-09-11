// electron-builder hook. npm ships beside app.asar exactly as npm publishes it: packaged
// as a dependency, its bundled modules would be hoisted into the archive, where the real
// Node that runs npm cannot read them.
const { cpSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const from = join(context.packager.projectDir, 'node_modules', 'npm')
  const to = join(context.packager.getResourcesDir(context.appOutDir), 'npm')
  cpSync(from, to, { recursive: true, dereference: true })
}
