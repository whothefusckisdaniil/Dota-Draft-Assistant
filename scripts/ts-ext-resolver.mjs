/**
 * Node resolve hook: allow research scripts to import TypeScript modules that
 * themselves use extensionless relative imports.
 *
 * `src/scoring/itemPrior.ts` does `import ... from './itemStats'`, which Vite,
 * tsc and vitest all resolve. Bare Node with --experimental-strip-types does
 * not, so a research script importing it dies with ERR_MODULE_NOT_FOUND.
 *
 * This hook appends `.ts` as a last resort. It changes NOTHING in src/ and is
 * never loaded by the app or by tests.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
