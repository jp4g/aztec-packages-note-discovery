import { ContractSyncService } from '@aztec/pxe/server';

/** No-op implementation of ContractSyncService for TXE where syncing is managed externally. */
export class NoopContractSyncService extends ContractSyncService {
  constructor() {
    // @ts-expect-error - We're intentionally passing nulls since this is a no-op implementation
    super(null, null, { debug: () => {} });
  }

  override async ensureContractSynced(): Promise<void> {
    // No-op: syncing is managed externally
  }

  override wipe(): void {
    // No-op
  }
}
