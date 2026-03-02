import { type PXE, type TaggingSecretExport } from '@aztec/pxe/server';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';

import { EmbeddedWallet } from '../embedded/embedded_wallet.js';

export class AuditableEmbeddedWallet extends EmbeddedWallet {
  /**
   * Export tagging secrets for a given account and set of apps.
   * Delegates to the underlying PXE's exportTaggingSecrets method.
   */
  async exportTaggingSecrets(
    account: AztecAddress,
    apps: AztecAddress[],
    counterparties?: AztecAddress[],
  ): Promise<TaggingSecretExport> {
    return (this.pxe as PXE).exportTaggingSecrets(account, apps, counterparties);
  }
}
