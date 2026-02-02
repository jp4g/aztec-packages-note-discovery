import type { Logger } from '@aztec/foundation/log';
import type { FunctionCall, FunctionSelector } from '@aztec/stdlib/abi';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import type { BlockHeader } from '@aztec/stdlib/tx';

import type { ContractStore } from '../storage/contract_store/contract_store.js';
import { syncState, verifyCurrentClassId } from './helpers.js';

/**
 * Service for caching contract synchronization status. Ensures each contract is only synced once per
 * anchor block, avoiding redundant sync_state calls during transaction simulation.
 */
export class ContractSyncService {
  /** Tracks contracts synced since last wipe. Key is contract address string. */
  private syncedContracts: Map<string, Promise<void>> = new Map();

  constructor(
    private aztecNode: AztecNode,
    private contractStore: ContractStore,
    private log: Logger,
  ) {}

  /**
   * Ensures a contract's private state is synchronized and that the PXE holds the current class artifact.
   * Uses a cache to avoid redundant sync operations - the cache is wiped when the anchor block changes.
   * @param contractAddress - The address of the contract to sync.
   * @param functionToInvokeAfterSync - The function selector that will be called after sync (used to validate it's not sync_state itself).
   * @param utilityExecutor - Executor function for running the sync_state utility function.
   * @param header - The block header to use for verification.
   */
  async ensureContractSynced(
    contractAddress: AztecAddress,
    functionToInvokeAfterSync: FunctionSelector | null,
    utilityExecutor: (call: FunctionCall) => Promise<any>,
    header: BlockHeader,
  ): Promise<void> {
    const key = contractAddress.toString();

    const existing = this.syncedContracts.get(key);
    if (existing) {
      return existing;
    }

    const syncPromise = this.doSync(contractAddress, functionToInvokeAfterSync, utilityExecutor, header);
    this.syncedContracts.set(key, syncPromise);

    try {
      await syncPromise;
    } catch (err) {
      // Remove failed sync from cache so it can be retried
      this.syncedContracts.delete(key);
      throw err;
    }
  }

  private async doSync(
    contractAddress: AztecAddress,
    functionToInvokeAfterSync: FunctionSelector | null,
    utilityExecutor: (call: FunctionCall) => Promise<any>,
    header: BlockHeader,
  ): Promise<void> {
    this.log.debug(`Syncing contract ${contractAddress}`);
    await Promise.all([
      syncState(contractAddress, this.contractStore, functionToInvokeAfterSync, utilityExecutor),
      verifyCurrentClassId(contractAddress, this.aztecNode, this.contractStore, header),
    ]);
    this.log.debug(`Contract ${contractAddress} synced`);
  }

  /** Clears sync cache. Called by BlockSynchronizer when anchor block changes. */
  wipe(): void {
    this.log.debug(`Wiping contract sync cache (${this.syncedContracts.size} entries)`);
    this.syncedContracts.clear();
  }
}
