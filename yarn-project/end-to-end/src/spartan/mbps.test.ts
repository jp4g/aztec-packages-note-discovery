import { NO_WAIT } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import type { AztecNode } from '@aztec/aztec.js/node';
import { BlockNumber } from '@aztec/foundation/branded-types';
import { timesAsync } from '@aztec/foundation/collection';
import { createLogger } from '@aztec/foundation/log';
import { retryUntil } from '@aztec/foundation/retry';
import { TestWallet, proveInteraction } from '@aztec/test-wallet/server';

import { expect, jest } from '@jest/globals';

import { getSponsoredFPCAddress } from '../fixtures/utils.js';
import {
  type TestAccounts,
  createWalletAndAztecNodeClient,
  deploySponsoredTestAccountsWithTokens,
} from './setup_test_wallets.js';
import {
  ChainHealth,
  type ServiceEndpoint,
  getRPCEndpoint,
  setupEnvironment,
  updateSequencersConfig,
} from './utils.js';

const config = setupEnvironment(process.env);

describe('multi-blocks-per-slot network test', () => {
  jest.setTimeout(60 * 60 * 1000); // 60 minutes

  const logger = createLogger('e2e:spartan-test:mbps');
  const endpoints: ServiceEndpoint[] = [];
  const health = new ChainHealth(config.NAMESPACE, logger);

  let wallet: TestWallet;
  let aztecNode: AztecNode;
  let cleanup: undefined | (() => Promise<void>);
  let testAccounts: TestAccounts;

  const MINT_AMOUNT = 100_000n;
  const TRANSFER_AMOUNT = 1n;
  const TX_COUNT = 15;
  const BLOCK_DURATION_MS = 8000; // mirrors e2e_epochs/epochs_mbps.parallel.test.ts

  beforeAll(async () => {
    await health.setup();

    const rpcEndpoint = await getRPCEndpoint(config.NAMESPACE);
    endpoints.push(rpcEndpoint);

    ({ wallet, aztecNode, cleanup } = await createWalletAndAztecNodeClient(
      rpcEndpoint.url,
      config.REAL_VERIFIER,
      logger,
    ));
    testAccounts = await deploySponsoredTestAccountsWithTokens(wallet, aztecNode, MINT_AMOUNT, logger);

    await updateSequencersConfig(config, {
      minTxsPerBlock: 1,
      maxTxsPerBlock: 1,
      blockDurationMs: BLOCK_DURATION_MS,
    });
  });

  afterAll(async () => {
    await health.teardown();
    await cleanup?.();
    endpoints.forEach(e => e.process?.kill());
  });

  it('includes all submitted txs across multiple blocks in a single slot', async () => {
    const feePaymentMethod = new SponsoredFeePaymentMethod(await getSponsoredFPCAddress());

    const txs = await timesAsync(TX_COUNT, i => {
      const from = testAccounts.accounts[i % testAccounts.accounts.length];
      return proveInteraction(
        wallet,
        testAccounts.tokenContract.methods.transfer_in_public(from, testAccounts.recipientAddress, TRANSFER_AMOUNT, 0),
        { from, fee: { paymentMethod: feePaymentMethod } },
      );
    });

    const txHashes = await Promise.all(txs.map(tx => tx.send({ wait: NO_WAIT })));
    logger.info(`Submitted ${txHashes.length} txs`);

    const receipts = await retryUntil(
      async () => {
        const resolved = await Promise.all(
          txHashes.map(async hash => {
            try {
              return await aztecNode.getTxReceipt(hash);
            } catch {
              return undefined;
            }
          }),
        );
        if (resolved.some(receipt => !receipt?.blockNumber)) {
          return undefined;
        }
        return resolved;
      },
      'all tx receipts',
      config.AZTEC_SLOT_DURATION * 10,
      2,
    );

    const blockNumbers = receipts.map(receipt => Number(receipt!.blockNumber));
    const uniqueBlockNumbers = [...new Set(blockNumbers)];
    expect(uniqueBlockNumbers.length).toBeGreaterThanOrEqual(2);
    expect(uniqueBlockNumbers.length).toBe(txHashes.length);

    const headers = await Promise.all(
      uniqueBlockNumbers.map(blockNumber => aztecNode.getBlockHeader(BlockNumber(blockNumber))),
    );
    if (headers.some(header => !header)) {
      throw new Error('Failed to load block headers for submitted txs');
    }

    const slotNumbers = headers.map(header => header!.globalVariables.slotNumber);
    expect(new Set(slotNumbers).size).toBe(1);

    const slotNumber = slotNumbers[0];
    const blocksInSlotCount = headers.filter(header => header!.globalVariables.slotNumber === slotNumber).length;
    expect(blocksInSlotCount).toBeGreaterThanOrEqual(2);
    const receiptSlotNumbers = await Promise.all(
      blockNumbers.map(blockNumber =>
        aztecNode.getBlockHeader(BlockNumber(blockNumber)).then(header => header!.globalVariables.slotNumber),
      ),
    );
    expect(receiptSlotNumbers.every(receiptSlotNumber => receiptSlotNumber === slotNumber)).toBe(true);

    const maxBlockNumber = Math.max(...blockNumbers);
    await retryUntil(
      async () => {
        const tips = await aztecNode.getL2Tips();
        return Number(tips.checkpointed.block.number) >= maxBlockNumber;
      },
      'checkpointed tip to reach multi-block slot',
      config.AZTEC_SLOT_DURATION * 10,
      2,
    );
  });
});
