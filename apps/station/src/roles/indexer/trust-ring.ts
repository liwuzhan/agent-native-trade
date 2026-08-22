/**
 * @agent-trade/station — indexer trust-ring hot reload (module S2).
 *
 * `@agent-trade/local-store` loads `.data/keys/*.key` into its in-memory trust
 * ring only inside `openStore`. A key file written by another station while
 * this indexer is already running is therefore invisible to `store.putObject`
 * (which re-verifies against that in-memory ring), forcing a restart before a
 * freshly-arrived signer could announce. This helper re-syncs the in-memory
 * ring from disk before verification, so a key added or rotated at runtime is
 * honoured without restarting.
 *
 * Implementation choice (option b, not touching M3): re-scan the keys directory
 * and re-inject every on-disk seed through the *existing* `Store.saveKey`
 * method. `saveKey` is idempotent and updates both the on-disk file and the
 * in-memory ring, so the local-store package stays byte-for-byte unchanged and
 * its 19 acceptance tests keep passing.
 *
 * `.data/peers/*.pub` (the read-only public-key ring, M10 cross-machine
 * signing) is deliberately not reloaded here: the M3 surface has no "save
 * peer" method, and the indexer's announce `resolveKey` only ever consults
 * `.data/keys/` (see `createIndexerRole`), so a peer-only signer is rejected
 * up front as `fail:unknown_signer` before it could reach `putObject`. Peer
 * hot reload is therefore not observable on this contract.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { StationContext } from '../../types.js';

export function reloadTrustRing(ctx: StationContext): void {
  const keysDir = join(ctx.dataDir, '.data', 'keys');
  let names: string[];
  try {
    names = readdirSync(keysDir);
  } catch {
    return; // no keys directory yet — nothing to reload
  }
  for (const name of names) {
    if (!name.endsWith('.key')) continue;
    try {
      const agentId = decodeURIComponent(name.slice(0, -'.key'.length));
      const seed = readFileSync(join(keysDir, name), 'utf8').trim();
      ctx.store.saveKey(agentId, seed);
    } catch {
      // unreadable file, undecodable agentId, or an invalid seed (saveKey
      // derives the public key and throws): skip this entry rather than
      // failing the request.
    }
  }
}
