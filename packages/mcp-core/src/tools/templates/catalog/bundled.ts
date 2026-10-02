import { type CatalogStore, createCatalogStore } from './index.js';

let catalogPromise: Promise<CatalogStore> | undefined;

/**
 * Load and validate the immutable catalog once per process.
 *
 * Keep the 1 MB generated JSON in a code-split chunk: most tool calls never
 * use template recommendations. A failed validation is deliberately not
 * cached, preserving the old loader's retry-on-failure behavior.
 */
export function getBundledTemplateCatalog(): Promise<CatalogStore> {
  catalogPromise ??= import('./snapshot.js')
    .then(({ default: generatedCatalog }) => createCatalogStore(generatedCatalog))
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}
