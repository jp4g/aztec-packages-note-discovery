import {
  createAztecNodeClient,
  waitForNode,
  waitForTx,
} from "@aztec/aztec.js/node";
import {
  TestWallet,
  registerInitialLocalNetworkAccountsInWallet,
} from "@aztec/test-wallet/server";
import { TokenContract, type Transfer } from "@aztec/noir-contracts.js/Token";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { Fr } from "@aztec/aztec.js/fields";
import { NO_WAIT, BatchCall } from "@aztec/aztec.js/contracts";

// Setup: connect to network
const node = createAztecNodeClient("http://localhost:8080");
await waitForNode(node);
const wallet = await TestWallet.create(node);

const [aliceAddress, bobAddress] =
  await registerInitialLocalNetworkAccountsInWallet(wallet);

// Deploy a token contract for examples
const token = await TokenContract.deploy(
  wallet,
  aliceAddress,
  "TestToken",
  "TST",
  18,
).send({ from: aliceAddress });

await token.methods
  .mint_to_public(aliceAddress, 10000n)
  .send({ from: aliceAddress });

// docs:start:no_wait_deploy
// Use NO_WAIT to get the transaction hash immediately and track deployment
const txHash = await TokenContract.deploy(
  wallet,
  aliceAddress,
  "AnotherToken",
  "ATK",
  18,
).send({
  from: aliceAddress,
  wait: NO_WAIT,
});

console.log(`Deployment tx: ${txHash}`);

// Wait for the transaction to be mined using the node
const receipt = await waitForTx(node, txHash);
console.log(`Deployed in block ${receipt.blockNumber}`);
// docs:end:no_wait_deploy

// docs:start:no_wait_transaction
// Use NO_WAIT for regular transactions too
const transferTxHash = await token.methods
  .transfer(bobAddress, 100n)
  .send({ from: aliceAddress, wait: NO_WAIT });

console.log(`Transaction sent: ${transferTxHash.toString()}`);

// Wait for inclusion later using the node
const transferReceipt = await waitForTx(node, transferTxHash);
console.log(`Transaction mined in block ${transferReceipt.blockNumber}`);
// docs:end:no_wait_transaction

// docs:start:batch_call
// Execute multiple calls atomically using BatchCall
const batch = new BatchCall(wallet, [
  token.methods.mint_to_public(aliceAddress, 500n),
  token.methods.transfer(bobAddress, 200n),
]);

const batchReceipt = await batch.send({ from: aliceAddress });
console.log(`Batch executed in block ${batchReceipt.blockNumber}`);
// docs:end:batch_call

// docs:start:sponsored_fpc_setup
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";

// Derive the Sponsored FPC address from its deployment parameters
const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
  SponsoredFPCContract.artifact,
  {
    salt: new Fr(0),
  },
);

// Register the contract with your wallet before using it
await wallet.registerContract(
  sponsoredFPCInstance,
  SponsoredFPCContract.artifact,
);

// Create the payment method
const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
  sponsoredFPCInstance.address,
);

// Use it to pay for transactions
const sponsoredReceipt = await token.methods
  .transfer(bobAddress, 50n)
  .send({
    from: aliceAddress,
    fee: { paymentMethod: sponsoredPaymentMethod },
  });
console.log(`Sponsored tx in block ${sponsoredReceipt.blockNumber}`);
// docs:end:sponsored_fpc_setup

// docs:start:reconstruct_contract_instance
import { PublicKeys } from "@aztec/stdlib/keys";

// Reconstruct a contract instance from deployment parameters
// Use this when you need to register a contract deployed by someone else
const reconstructedInstance = await getContractInstanceFromInstantiationParams(
  TokenContract.artifact,
  {
    publicKeys: PublicKeys.default(),
    constructorArtifact: "constructor",
    constructorArgs: [aliceAddress, "ReconstructedToken", "RTK", 18],
    deployer: aliceAddress,
    salt: new Fr(12345), // The original deployment salt
  },
);

// Register the reconstructed contract with the wallet
await wallet.registerContract(reconstructedInstance, TokenContract.artifact);
console.log(
  `Reconstructed contract address: ${reconstructedInstance.address.toString()}`,
);
// docs:end:reconstruct_contract_instance

// docs:start:query_tx_status
// Query transaction status after sending without waiting
const statusTxHash = await token.methods
  .transfer(bobAddress, 10n)
  .send({ from: aliceAddress, wait: NO_WAIT });

// Check status using the node
const txReceipt = await node.getTxReceipt(statusTxHash);

console.log(`Status: ${txReceipt.status}`);
console.log(`Block number: ${txReceipt.blockNumber}`);
console.log(`Transaction fee: ${txReceipt.transactionFee}`);
// docs:end:query_tx_status

// docs:start:deploy_with_dependencies
// Deploy contracts with dependencies - deploy sequentially and pass addresses
const baseToken = await TokenContract.deploy(
  wallet,
  aliceAddress,
  "BaseToken",
  "BASE",
  18,
).send({ from: aliceAddress });

// A second contract could reference the first (example pattern)
const derivedToken = await TokenContract.deploy(
  wallet,
  baseToken.address, // Use first contract's address as admin
  "DerivedToken",
  "DERIV",
  18,
).send({ from: aliceAddress });

console.log(`Base token at: ${baseToken.address.toString()}`);
console.log(`Derived token at: ${derivedToken.address.toString()}`);
// docs:end:deploy_with_dependencies

// docs:start:parallel_deploy
// Deploy contracts in parallel using Promise.all
const contracts = await Promise.all([
  TokenContract.deploy(wallet, aliceAddress, "Token1", "T1", 18).send({
    from: aliceAddress,
  }),
  TokenContract.deploy(wallet, aliceAddress, "Token2", "T2", 18).send({
    from: aliceAddress,
  }),
  TokenContract.deploy(wallet, aliceAddress, "Token3", "T3", 18).send({
    from: aliceAddress,
  }),
]);

console.log(`Contract 1 at: ${contracts[0].address}`);
console.log(`Contract 2 at: ${contracts[1].address}`);
console.log(`Contract 3 at: ${contracts[2].address}`);
// docs:end:parallel_deploy

// docs:start:skip_initialization
// Deploy without running the constructor using skipInitialization
const uninitializedToken = await TokenContract.deploy(
  wallet,
  aliceAddress,
  "UninitToken",
  "UNIT",
  18,
).send({
  from: aliceAddress,
  skipInitialization: true,
});

console.log(`Uninitialized contract at: ${uninitializedToken.address}`);

// Initialize later by calling the constructor manually
await uninitializedToken.methods
  .constructor(aliceAddress, "UninitToken", "UNIT", 18)
  .send({ from: aliceAddress });

console.log("Contract initialized");
// docs:end:skip_initialization

// docs:start:poll_for_events
import { getDecodedPublicEvents } from "@aztec/aztec.js/events";

// Poll for new events at regular intervals
let lastProcessedBlock = await node.getBlockNumber();

async function pollForTransferEvents() {
  const currentBlock = await node.getBlockNumber();

  if (currentBlock > lastProcessedBlock) {
    const events = await getDecodedPublicEvents<Transfer>(
      node,
      TokenContract.events.Transfer,
      lastProcessedBlock + 1,
      currentBlock - lastProcessedBlock,
    );

    for (const event of events) {
      // Process each transfer event
      console.log(`Transfer: ${event.amount} from ${event.from} to ${event.to}`);
    }

    lastProcessedBlock = currentBlock;
  }
}

// Example: poll once (in production, use setInterval)
await pollForTransferEvents();
// docs:end:poll_for_events

console.log("All advanced examples completed successfully");
