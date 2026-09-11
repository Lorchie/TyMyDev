const stub = new URL('./electron.mjs', import.meta.url).href

/**
 * Lets `node --test` load the main-process sources as they are: `electron` becomes a
 * stub, and extensionless relative imports resolve to their .ts file.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: stub, shortCircuit: true }
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        /* try the next shape */
      }
    }
  }
  return nextResolve(specifier, context)
}
