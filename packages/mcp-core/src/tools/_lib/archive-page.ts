import { container } from '@sapphire/pieces';
import { archivePageContract } from './archive-contract.js';

/** Node adapter; the pagination contract itself has no runtime dependencies. */
export const archivePage: typeof archivePageContract = (raw, parent, limit, before, joined) =>
  archivePageContract(
    raw,
    parent,
    limit,
    before,
    joined,
    container.config.ALLOWED_GUILDS?.split(',').map((id) => id.trim()),
  );
