import generatedCatalog from './catalog.generated.json' with { type: 'json' };
import { createCatalogStoreLoader } from './index.js';

/** Load and validate the immutable catalog bundled with this package once per process. */
export const getBundledTemplateCatalog = createCatalogStoreLoader(() => generatedCatalog);
