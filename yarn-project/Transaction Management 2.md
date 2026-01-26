# Transaction Management 2

Last edited time: January 26, 2026 9:18 AM
Tech Lead: Phil
Contributors: Nikola Mratinic
Approver: Nikola Mratinic, Santiago Palladino
Linear Issue/Project: https://linear.app/aztec-labs/project/alpha-network-performance-70eb00d71102/overview

# Problem Statement & Executive Summary

Sequencers need transactions to include into Aztec blocks. Validators and Provers need access to those transactions to re-execute those same Aztec blocks. Transactions enter the network via an RPC endpoint and propagate around a P2P network. The network consists of ‘regular’ nodes as well as validators and prover nodes. In an ideal world a number of things would be true:

1. All nodes would receive all transactions.
2. There would be no malicious nodes and no need to consider malicious or invalid transactions.
3. All nodes could store all transactions.

The nature of permissionless P2P networks means the above conditions don’t necessarily hold. We therefore need to design a network and transaction management system that can facilitate continued block production.

# The Network

We use libp2p and gossipsub as the p2p gossiping mechanism. Many aspects of this system are perfect for our needs. Being able to configure gossiping topics, peer ‘mesh’ sizes, peer scoring and the ability to validate messages before being propagated further.

Every node on the network, upon receipt of a transaction needs to perform a number of steps.

1. Basic transaction validation. e.g. Is it for the correct chain?
2. Expensive transaction validation. e.g. Is the proof valid?
3. Attempt to insert the transaction into the node’s transaction pool. Validating on the way in that doing so does not break certain constraints. e.g. Would it result in multiple transactions with identical nullifiers being present in the pool.
4. On the basis of the above checks, one of 3 actions are taken:
    1. The transaction is accepted, resulting in further propagation.
    2. The transaction is rejected. Propagation is prevented and the peer from which it was received is penalised through peer scoring.
    3. The transaction is ignored. Propagation is prevented but no penalty is issued. This happens in the case the transaction was valid just not desired.

Preventing propagation in the case of valid but undesired transactions prevents the network from being flooded by cheap transactions that nobody is realistically going to want. It also aids in maintaining consistency between the transaction pools of all the nodes on the network.

The second aspect of the network is to provide a request/response system for transaction retrieval. As we will discuss further down, transactions may need to be retrieved from other nodes. Once again, we can’t assume that the node we request them from is not malicious and anything received will need to be validated.

## The Transaction Pool

When it comes to transaction pool implementation. We should first look at the equivalent in the Ethereum clients.

> Geth and Nethermind have similar transaction pool implementations; we will look closely at that of Geth.
>

> Geth stores all transactions in memory (with the exception of those received over RPC at the node). It does so by defining a configurable number of ‘slots’, defaulting to around 5000. Each slot is considered 32KB in size and a transaction occupies 1 or more slots based on its size up to a maximum of 128KB. A typical transaction is considerably less than 32KB so in practice this permits a total of around 5000 transactions. About 8 minutes worth at 10TPS.
>

> Additionally, there is a non-executable pool reserved for transactions with future nonces that are then promoted to the main pool as and when those nonces become valid. There are also limits on the number of outstanding transactions per account. Neither of these items are relevant to us as it is not possible for an Aztec node to determine the account of the transaction and there is no concept of nonce.
>

We have some requirements that differ from that of Ethereum, but I feel it is valuable to take some of the experience of these long-standing node implementations.

One of the biggest differences between our network and that of Ethereum is the need for nodes to keep hold of transactions. Ethereum block proposals contain the transactions. Additionally, transactions are only required for block validation via re-execution. Aztec transactions are too large to propagate along with the proposals meaning validators have to retrieve them from their own stores. As well as during re-execution, they are also required during proving, a process which occurs sometime after block validation, so they need to remain in the network for longer. For this reason we will persist transactions to disk for a period of time.

## Transaction Lifecycle

The lifecycle of transactions in the pool is summarised in the following table.

| State     | Meaning                                                                                                                                                             | Possible Future States         | Notes |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----- |
| Pending   | Available to be added to a block, can be evicted. this is the collection of transactions that the network ‘wants’ to store because they are desirable.              | Protected, Mined, Soft Deleted |       |
| Protected | Added to a proposal, must not be evicted. Not available to be added to a block. Transactions remain in this state for the duration of the slot they are needed for. | Mined, Pending                 |       |
| Mined     | Confirmed as added to a block. This is to say it is included on L2, not necessarily checkpointed on L1. Must not be evicted.                                        | Deleted, Pending               |       |
| Deleted   | Removed from the pool                                                                                                                                               | N/A                            |       |

To further state the above, one can think of 2 separate transaction pools, that of Pending transactions, and that of Protected/Mined. Only transactions in the Pending pool can be evicted or selected to be added to block proposals. The Protected/Mined pool stores transactions for the purposes of ensuring successful block attestation and proving. To enter the Pending pool, either as a new transaction or to be moved from one of the other states effectively requires a challenge. A challenge determines if, for any reason, the incoming transaction and one or more already in the pending pool can’t co-exist. If this is the case then the incoming transaction will require a priority fee higher than all conflicting transactions to be permitted. If it’s fee is ower, it is rejected, if higher, all confli Additionally, transactions being added to the pending pool will need to undergo a set of validations. This is discussed in more detail later.

Transactions are protected for the duration of a slot. The intention here is to prevent eviction whilst execution of blocks takes place. Protecting for the slot ensures that transactions remain generally available for any nodes that require them in order to re-execute. Protected transactions are stored against the slot number they are protected for. This protection is once the slot has passed. Mined transactions are implicitly protected by virtue of them being Mined.

We can derive sets of deterministic state transitions for transactions and then define the events and function calls that drive those transitions.

### State Transitions

| Transition                                       | Event                                                                                             | Handler/s                                              | Effect                                              | Criteria                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------- |
| N/A → New pending transaction                    | Transaction received via gossip                                                                   | `addPendingTxs(txs: Tx[]);`                            | Transaction added to pending pool                   | Tx is evaluated against the pending pool.    |
| Pending → Protected                              | Transaction included in a proposal. Also called by proposer.                                      | `addProtectedTxs(txs: Tx[], block: BlockHeader);`      |
| `protectTxs(txs: TxHash[], block: BlockHeader);` | Transaction moved from pending pool to protected pool                                             | None, txs are always added to protected pool           |
| Protected → Mined                                | New proposed block mined. The block has been added to the archiver after successful re-execution. | `handleMinedBlock(txs: TxHash[], block: BlockHeader);` | Transaction moved from protected pool to mined pool | None, txs are always added to mined pool.    |
| Protected → Pending                              | Proposal execution fails                                                                          | `handleMinedBlock(txs: TxHash[], block: BlockHeader);` |
| `prepareForSlot(slotNumber: Slotnumber);`        | Transaction moved from protected pool to pending pool                                             | Tx is evaluated against the pending pool.              |
| N/A → New protected transaction                  | Transaction included in a proposal (we didn’t previously have it)                                 | `addProtectedTxs(txs: Tx[]);`                          | Transaction added to protected pool                 | None, txs are always added to protected pool |
| Mined → Pending                                  | Transaction in pruned block                                                                       | `handlePrunedBlocks(latestBlock: L2BlockId);`          | Transactions moved from mined pool to pending pool  | Tx is evaluated against the pending pool     |
| Mined → Deleted                                  | Transaction in pruned block (no longer valid)                                                     | `handlePrunedBlocks(latestBlock: L2BlockId);`          | Transaction is removed from the store completely    | None, txs are always deleted when required   |
| Pending → Deleted                                | Transaction has been deemed unwanted or invalid                                                   | N/A (happens internally to the pool)                   | Transaction is removed from the store completely    | None, txs are always deleted when required   |
| Pending → Deleted                                | Transaction has been deemed unwanted or invalid                                                   | `handleFailedExecution(txs: TxHash[]);`                | Transaction is removed from the store completely    | None, txs are always deleted when required   |
| Pending → Delete                                 | Transaction has been invalidated by a mined block                                                 | `handleMinedBlock(txs: TxHash[], block: BlockHeader);` | Transaction is removed from the store completely    | None, txs are always deleted when required   |
| Mined → Deleted (finalisation)                   | L1 finalisation                                                                                   | `handleFinalizedBlock(block: BlockHeader);`            | Transaction is removed from the store completely    | None, txs are always deleted when required   |
| N/A → New mined transaction                      | Transaction received via req/resp for proving                                                     | `addMinedTxs(txs: Tx[]);`                              | Transaction added to mined pool                     | None, txs are always added to mined pool     |

We can now consider each transition and define at what point in the node’s operations each of these handlers will need to be called and for what reason.

1. New pending transaction
    1. The handler `addPendingTxs(txs: Tx[]);`  is called when a transaction is received at the node via RPC or gossip. The transaction must have passed validations such that we know the transaction itself is valid. Within the handler, further validations will be made to ensure that for example it is valid against the current state (e.g. no duplicate nullifiers).
2. New protected transaction
    1. The handler `addProtectedTxs(txs: Tx[], block: BlockHeader);` may be called when a transaction is received at the node as a result of specifically requesting it over request/response. The request will have been made to retrieve the transaction for the purposes of block re-execution, it must be added to the pool as being immediately Protected and associated with the `SlotNumber` in the given `BlockHeader`. These transactions will have passed basic validations to ensure the payload is consistent and they have valid proofs. We don’t validate these transactions against the state as they must be kept and validated during block execution.
3. Protecting included transactions by the proposer
    1. The handler `addProtectedTxs(txs: Tx[], block: BlockHeader);` is called by the block proposer immediately after a block is built with the transactions contained in that block. This ensures that all transactions in the block are held in the pool, in the Protected state. This mitigates against transactions being evicted whilst block building is in progress. If for any reason, block execution fails (i.e. the proposal is never going to be transmitted), then this call it NOT made.
4. Protecting included transactions by all nodes
    1. The handler `protectTxs(txs: TxHash[], block: BlockHeader);` is called by every node upon receipt of a valid block proposal. This will protect all currently available transactions. Any unavailable transactions will need to be retrieved via request/response (and then potentially added as per action 2). This method should return any unavailable transaction hashes. Note, as we will see further down, it is possible that a transaction is already protected against  an earlier `SlotNumber`. This call will update the slot against which that transaction is protected provided the new slot is higher. The pool will maintain the information about all of the transactions that are protected here, even those not currently present in the pool. this means that if a transaction happens to be received over gossip, it can be immediately set to protected.
5. Transaction is mined
    1. The handler `handleMinedBlock(txs: TxHash[], block: BlockHeader);` is called upon notification of a mined block. Note that ‘mined’ here refers to the point at which the archiver is provided with the block after successful re-execution. Each transaction in the list provided is moved to the Mined state.
6. Transaction is deleted by a mined block
    1. The handler `handleMinedBlock(txs: TxHash[], block: BlockHeader);` is called upon notification of a mined block. This can invalidate pending transactions which share nullifiers with transactions in the block.
7. Un-protecting transactions
    1. Transactions become unprotected by a ‘slot watcher’ process which continually monitors L1 for new slots and calls the `prepareSlot(slotNumber: SlotNumber);` handler. This removes protection for all transactions protected in earlier slots.
    2. Additionally, the `prepareSlot(slotNumber: SlotNumber);` handler is called by the proposer of a block to ensure that the pool is ready for new proposals.
8. Transaction is ‘un-mined’ via a chain prune
    1. When a chain prune occurs, transactions that were mined in those pruned blocks are moved back to the pending pool provided they survive the challenge and validation processes.
9. Transaction is deleted via a chain prune
    1. When a chain prune occurs, many transactions will be invalidated. For example, transactions that were built from blocks that have been pruned. These transactions will become Deleted upon calling the `handlePrunedBlocks(latestBlock: L2BlockId);` handler.
10. Transaction is deleted as a result of failed execution
    1. When a block is built by the proposer, any transactions that fail execution are immediately set to Deleted. Note, this only occurs in the case of the proposer. Validators don’t do this, they follow the path described in point 6. This is done via a call to the handler `handleFailedExecution(txs: TxHash[]);` which will set all Pending transactions matching one of the provided hashes to Deleted.
11. Transaction is deleted as beyond L1 finalisation
    1. When blocks (checkpoints) are finalised on L1, the handler `handleFinalizedBlock(block: BlockHeader);` will be called. All transactions mined in that block or earlier blocks will be deleted.
12. New mined transaction
    1. Mined transactions are retrieved as required by prover nodes. This will happen via request/response and they will be added to the using the `addMinedTxs(txs: Tx[])` handler.

## Pre-insertion validation

As explained in the Network section above, we want nodes to be able to make decisions around whether transactions are to be accepted, rejected or ignored when received via gossip. As gossip is completely unsolicited and some validations are relatively expensive, we want to be able to determine if a transaction is likely to be added to the pool before performing the more expensive checks. For this reason, the pool will expose a `canAddPendingTxs(txs: Tx[]);` . This will perform a number of checks and return accordingly:

1. Transactions will be validated against the current state. Any transactions that fail checks such as double spends will be returned by this call as rejections, invoking peer scoring penalties.
2. Transactions that are valid but not desirable will be returned as needing to be ignored. These will not be propagated further but won’t invoke peer scoring penalties.

The pending pool will be left unmodified by this function. Performing these checks here means that the most expensive validations can be deferred to after we have a strong indication that the transaction will be accepted. Peers that send us transactions that are rejected will be penalised by the peer scoring mechanism. Peers that send us many valid, but undesirable transactions over a period of time should also be penalised.

## Protecting Against Race Conditions

Ordinarily, the expected lifecycle of a transaction would look like as follows:

1. Transaction received via RPC or gossip, added to Pending pool.
2. Transaction included into block, marked as protected by that slot. This is done by both the proposer immediately after execution and every other node immediately upon receipt of the proposal.
3. The block is re-executed successfully, pushed to the archiver resulting in a ‘block mined’ event. The transaction’s state is updated as Mined.
4. Protection of the transaction is removed by the ‘slot watcher’ process as soon as the next slot starts.
5. Eventually, the block containing the transaction is finalised and the transaction is Deleted.

Alternatively, a chain prune is not an unexpected scenario, resulting in a different lifecycle:

1. The first 3 steps are identical to the above.
2. The block’s checkpoint is never published, or the block’s epoch is never proven, resulting in a prune event.
3. The transaction will be Deleted IF it is no longer valid.
4. If it is valid then it will be returned to the pending pool, provided the challenge and required validations are passed.
5. Protection of the transaction is removed by the ‘slot watcher’ process as soon as the transaction’s block’s slot passes. In the case of a single checkpoint prune this would be the next slot. In the case of a deeper prune this would have happened earlier than the prune event.

The events driving these transitions come from different sources, introducing non-deterministic behaviour and we have to be able to manage this. There are many potential race conditions that we need to consider.

1. The pool implementation will contain a queue. All handlers will be executed in their entirety via jobs on that queue. This ensures no interleaved execution given that inevitably many/all of the handlers will need to make asynchronous database calls.
2. Interaction point 3 is specifically designed to counter the race condition introduced where block execution happens independently of transaction eviction. Included transactions are not protected by virtue of them being retrieved from the transaction pool prior to inclusion. So we deliberately add them as protected after successful execution.
3. When transactions are received via request/response, they are added to the pool specifically as either Protected or Mined. This ensures that they will NOT be evicted and will not prompt the eviction of any transaction currently considered Pending. No challenge will take place on the Pending pool.
4. A race condition exists with pre-insertion validation. The call to `canAddPendingTxs(txs: Tx[]);` can return successful for a given transaction only for the later call to `addPendingTxs(txs: Tx[]);` fail. This is an acceptable trade-off and the node would simply respond to the result returned from `addPendingTxs(txs: Tx[])`.
5. Consider a situation where blocks have been pruned, but a given node is slightly behind and hasn’t taken either the prune into effect or handled the change in slot number. This could be a fairly common occurrence. Transactions will exist that are protected against the pruned slot. A block proposal is received containing 1 or more of those transactions. A call will be made to `protectTxs(txs: TxHash[], block: BlockHeader);` . This will update the slot protecting those transactions as the block proposal must be for a higher slot. In fact, the node could receive multiple proposals whilst still not having reacted to the prune or slot change if it’s sync problems were severe. The proposals could never result in mined blocks within the node as the `Archiver` wouldn’t accept them. At some point, once the sync problems are resolved, a chain prune event will be generated as will a slot change. The transactions in the blocks will be set as no longer Mined but the protected status of transactions received in the new proposals and corresponding slot would remain.

## Looking at Transaction Protection

The method of protection adds some complexity. We should describe it’s purpose and inspect it’s operation.

The basic principle of transaction protection is to prevent eviction of un-mined transactions that we want the network to keep hold of in the short term for purposes of block execution.

1. Transactions are protected against the required slot as soon as possible to prevent eviction. This includes transferring existing protection to later slots in case of our node being behind others and receiving proposals for ‘new’ slots ahead of our own sync processes.
2. A ‘slot watcher’ will monitor L1 for changes in the slot number and make a call into the transaction pool to un-protect transactions for earlier slots. This will involve them being moved to the pending pool provided they pass the required challenges and validations.
3. Additionally a call to `prepareSlot(slotNumber: SlotNumber)` can be made, usually by a slot proposer. This will perform the same function as the slot watcher and will prepare the pool so the proposer has the correct latest view of the pool.

## Eviction and Challenges

Normally, a transaction would be expected to traverse through all stages of the lifecycle: Pending → Protected → Mined → Deleted. There are a number of reasons why this lifecycle may be cut short.

1. Duplicate nullifier detection. Transactions in the pending pool can not share nullifiers. If this conflict occurs, the transaction with the lower priority fee is removed.
2. Fee payer balance. The pool will ensure that all transactions against a given fee payer can be paid for by that fee payer. Transactions are prioritised by their priority fee so the lower value transactions are removed if the balance check fails.
3. Transaction invalidated after mining. When a block is mined, nullifiers emitted from public will be added to the tree. These nullifiers will not have been visible to the transaction pool previously. This may cause transactions to be evicted.
4. Transaction invalidated after chain prune. When the chain is pruned, blocks are removed. This can result in transactions being invalidated as they reference non-existing blocks.

## Validations

To protect the network and ensure transactions can be process and proven, we perform extensive validations on received transactions. This table lists the validations, their cost, the penalty for failing validation and the point at which the validations are performed.

| Name                     | Criteria Validated                                                                            | Cost (Time/Resource) | Penalty for peer if relevant | 1. Gossiped Transactions | 2. RPC Received Transactions | 3. Requested Transactions | 4. Block Building | 5. Migration to Pending |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------- | ---------------------------- | ------------------------ | ---------------------------- | ------------------------- | ----------------- | ----------------------- |
| `SizeTxValidator`        | Is the transaction too large                                                                  | Small                | Medium                       | ✅                        | ✅                            | ✅                         | ✅                 |                         |
| `TxPermitted`            | Are txs permitted on the network                                                              | Small                | Medium                       | ✅                        | ✅                            |                           |                   |                         |
| `DataTxValidator`        | Basic transaction consistency (e.g. number of calldata entries equals number of public calls) | Small                | Medium                       | ✅                        | ✅                            | ✅                         |                   |                         |
| `MetadataTxValidator`    | Chain Id, Rollup version                                                                      | Small                | Medium                       | ✅                        | ✅                            | ✅                         |                   |                         |
| `TimestampTxValidator`   | Transaction is not expired                                                                    |                      | Medium                       | ✅                        | ✅                            |                           | ✅                 | ✅                       |
| `DoubleSpendTxVaidator`  | No duplicate nullifiers either in itself or against world state                               | Medium               | Low                          | ✅                        | ✅                            |                           | ✅                 | ✅                       |
| `GasTxValidator`         | Within gas limits and fee payer has sufficient balance                                        | Medium               | Low                          | ✅                        | ✅                            |                           | ✅                 | ✅                       |
| `PhasesTxValidator`      | Transaction has a permitted setup function (or no setup function)                             | Medium               | Medium                       | ✅                        | ✅                            |                           | ✅                 | ✅                       |
| `BlockHeaderTxValidator` | Transaction references a valid block header                                                   | Medium               | Low                          | ✅                        | ✅                            |                           | ✅                 | ✅                       |
| `TxProofValidator`       | The transaction’s ZK proof                                                                    | High                 | High                         | ✅                        | ✅                            | ✅                         |                   |                         |
1. Gossiped Transactions. Transaction receipt here is unsolicited so all validations are performed.
2. RPC received transactions. Like gossip, this is unsolicited so all validations are performed.
3. Requested Transactions. Transaction receipt here is solicited. The node has asked for the transaction in order to re-execute it. We verify the most basic properties of the payload received such as it’s size and the ZK proof. The transaction may be invalid with regards to the global state but this will be determined during block execution. This is important, as we need to attempt execution and then determine that the block is invalid for slashing purposes.
4. Block building. Transactions have a set of validations performed on them immediately before being included into a block. This ensures that at the point of inclusion the transaction remains valid. These validations are performed by both the proposer and validators.
5. Migration to Pending. Transactions that migrate from Protected or Mined states to pending need to have a set of validations performed on them before doing so. The transaction lifecycle dictates that transactions can be received by request/response, receive limited validations before being placed into the Protected/Mined pool. Once there it is not guaranteed that the more extensive checks that would normally be performed on transactions entering the Pending pool are ever carried out.

We will break down these validations into composable sets. For instance we can identify the following:

1. Fast, basic transaction validation. This is independent of current world state and only involves the transaction itself. Examples of this are `SizeTxValidator` and `DataTxValidator` . In this case of unsolicited transaction receipt, these should be performed as soon as the transaction is seen.
2. Validations performed at the point of adding to the pending pool. This includes `BlockHeaderTxValidator` and `DoubleSpendTxValidator`.
3. Expensive validations that are only performed when all other checks have passed. For unsolicited transactions this means performing these checks after both the most basic checks and once we have established that the transaction is desirable. This would include `TxProofValidator`.

# Transaction Pool Implementation

As explained earlier, unlike Ethereum clients we need to persist transactions for the purposes of ensuring they remain generally available to the network. We will attempt to minimise calls to the database and perform most operations in memory. Not only should we increase performance doing this but we will greatly reduce the number of asynchronous calls.

Transactions themselves will be stored, uncompressed, against their hash. They will only ever be written upon initial entry, deleted when no longer required or read when required to be included in a block or provided to a peer. We will not cache them in memory as the overhead of doing so is quite significant (10 mins at 10 TPS = 6000 transactions = ~1GB).

The size of the pending transaction is limited by the number of transactions. The protected/mined pool is effectively bounded by the number of transactions in unfinalised blocks.

We will maintain an in-memory store of `TxMetaData` objects. One per transaction. The goal of this object is to maintain enough information about each transaction to satisfy all queries around for example transaction state, priority order and resolving challenges against the pending pool.

```tsx
type TxMetaData = {
	txHash: TxHash;
	minedL2BlockId?: L2BlockId; // Block ID (number and hash) of the block in which the transaction was mined
	anchorBlockHeaderHash: Fr; // Hash of the block header the transaction uses as it's anchor
	priorityFee: bigint; // The total priority fee
	feePayer: AztecAddress;
	claimAmount: bigint;
	feeLimit: bigint;
	nullifiers: string[];
	protectedSlotNumber?: SlotNumber;
};
```

An instance of this type will be created for every transaction in the pool. At node startup, all of these will be hydrated into memory, contained within a map against the hash of the transaction. From this collection of objects, we will sparingly create additional in-memory indexes. It should be considered whether an index is absolutely necessary. An obvious index is of nullifiers to transaction hash as the complexity of detecting nullifier collisions without them could be considerable. Additionally I expect it may be necessary to create indexes of which transactions exist in the pending pool. In each case the need for an index comes from the frequency with which we require lookups against this information.

All of the fields within this `TxMetaData` type are immutable with the exception of `minedBlockNumber` and `protectedSlotNumber` . A transaction’s current state can be determined trivially:

```tsx
if (tx.minedBlockNumber !== undefined) {
	return MINED;
} else if (tx.protectedSlotNumber !== undefined) {
	return PROTECTED;
} else {
	return PENDING;
}
```

We would rather not persist the protected status of transactions. Protected transactions can be entered into the pool without having all validations performed against them. They therefore need to be fully validated before being added to the pending pool. We could persist this status, but it will add additional database operations. Instead, in the case of a restart, we will accept that previously protected transactions are no longer protected and validate all non-mined transactions before building the pending pool.

The value of `minedBlockNumber` will need to be retrieved from the `Archiver` at startup when the state of all transactions is hydrated.

We can arrive at a worst case approximation for the amount of memory required to store all of the `TxMetadata` objects in memory. The size of the object is dominated by the array of nullifiers. Whilst it is likely that the average transaction will only contain a few nullifiers, our worst case is a full complement of 64, requiring 2KB to store. Transactions are completely deleted either when they are evicted or when the epoch in which they are included is proven and the proof transactions finalised on Ethereum. With 72s slots, an epoch is approximately 40 mins. 2 Epochs plus L1 finalisation time is approximately 95 mins. 95 mins at 10TPS requires approximately 100MB of memory.

As an example handler implementation, the process of adding protected transactions might look as follows.

```tsx
public addProtectedTxs(tx: Tx[], blockHeader: BlockHeader) {
  return this.queue.put(() => this.#addProtectedTxs(tx, blockHeader));
}

private #addProtectedTxs(txs: Tx[], blockHeader: BlockHeader) {
  const metas = [];
  const newTxs  = [];
  for (const tx of txs) {
    const existing = this.metas.get(tx.hash());
    if (existing) {
      existing.protectedBlockNumber = blockHeader.getBlockNumber();
      existing.protectedSlotNumber = blockHeader.getSlot();
      continue;
    }
    newTxs.push(tx);
    const meta = await buildMeta(tx, blockHeader);
    meta.protectedBlockNumber = blockHeader.getBlockNumber();
    meta.protectedSlotNumber = blockHeader.getSlot();
    metas.push(meta);
  }
  if (newTxs.length === 0) {
	  return;
	}
  return this.store.transactionAsync(async () => {
    for (let i = 0; i < newTxs.length; i++) {
      const tx = newTxs[i];
      await this.#txsDB.put(tx.hash(), tx);
      await this.#metasDB.set(tx.hash(), metas[i]);
    }
  });
}
```

### Dependencies

The transaction pool will require access to:

1. The `Archiver` via an injected `L2BlockSource` .
2. The world state via an injected `WorldStateSynchronizer` .
3. The aggregate validator used to validate transactions being considered for the pending pool. Again this will be provided via a constructor argument.

### Transaction Pool Operations

`addPendingTxs(txs: Tx[])`

This function will accept transactions to potentially be added to the pending pool. They will need to have current state validations performed on them as well as challenges against the current pending pool. The hashes of the transactions should also be checked against the collection of currently protected hashes and if protection exists, the transaction should be immediately protected. This function will need to return three collections of transaction hashes. Those that are accepted, those that are rejected and those are to be ignored. This is called at the point of receiving unsolicited new transactions via RPC and P2P.

`addProtected(txs: Tx[], block: BlockHeader)`

This function will accept transactions to be immediately added as protected against the slot provided in the header argument.

`protectTxs(txs: TxHash[], block: BlockHeader)`

This function will accept the hashes of transactions to be protected. Transactions that are already available will be protected from eviction. Additionally, hashes that aren’t available will be retained in case those transactions are received as say, pending transactions. In which case they will be immediately protected. This function will need to return the hashes that are unavailable in order for them to be retrieved via request/response.

`handleMinedBlock(txs: TxHash[], block: BlockHeader)`

This function will set the provided transactions as Mined in the block number given in the header. It will also invalidate pending transactions that share nullifiers with those in the new block, these transactions will be deleted.

`prepareForSlot(slotNumber: SlotNumber)`

This function will ensure the pending pool is current by unprotecting all transactions protected in earlier slots. This process will move un-mined transactions to the pending pool provided they pass the validations required to migrate from protected to pending and survive the eviction challenge.

`handlePrunedBlocks(latestBlock: L2BlockId)`

This function will un-mine all transactions Mined in blocks beyond the given latest block.

`handleFailedExecution(txs: TxHash[])`

This function will delete those transactions included in the given argument. This is called by the proposer after a block is built with the list of transactions that failed execution.

`handleFinalizedBlock(block: BlockHeader)`

This function deletes all transactions mined in the given block or earlier blocks.

`canAddPendingTxs(txs: Tx[])`

This function attempts to insert the given transactions into the pending pool, in the order given. However no modifications are made and the function simply returns the results of the attempt in the same way as `addPendingTxs(txs: Tx[])` .

### On Startup

When the node starts we will need to do the following:

1. Read all transactions from the database and build their meta data objects.
2. Attempt to retrieve every transaction from the `Archiver` , if successful, then the block is mined and should be recorded as such.
3. Validate all non-mined transactions, deleting those that are invalid.
4. Populate all indexes with remaining transactions.

### Changes to Validations

Aggregate validators are currently created in various places throughout the codebase. We will want to centralise this an organise validator into aggregated sets for the specific purposes of:

1. Block Building (as per the table)
2. Validating entry to the pending pool (as per the table)
3. Initial unsolicited receipt of a transaction (Validators that only perform checks on the transactions itself, minus the proof verification)
4. Expensive post ‘can-add’ validation (proof verification)
5. Minimal validation of transactions received via request/response (as per the table)

Current aggregate sets of validators are in:

`/yarn-project/validator-client/src/tx_validator/tx_validator_factory.ts`

 `/yarn-project/p2p/src/msg_validators/tx_validator/factory.ts`

`/home/phil/aztec/yarn-project/p2p/src/services/libp2p/libp2p_service.ts`

Then we need to ensure the correct sets of validators are applied to the various points where validation is required.

### Changes to Request/Response

The request response sub-system’s top level is file `/home/phil/aztec/yarn-project/p2p/src/services/tx_provider.ts`. In particular functions `getTxsForBlockProposal` and `getTxsForBlock` . Here we will need to pass in some sort of ‘context’ object which will ultimately be used to decide which `add` function on the transaction pool. Either `addProtectedTxs` or `addMinedTxs` . Then we will need to update the callers etc. For the validator it is protected, for the prover it is mined.

### Changes to Block Building

The following changes will need to be made when the proposer is building blocks.

1. At the start of the slot, the proposer calls `prepareSlot(slotNumber: SlotNumber)` .
2. The proposer calls `handleFailedExecution(txs: TxHash[])` with the hashes of all transactions that failed execution for each block.
3. The proposer calls `addProtectedTxs(txs: Tx[], blockHeader: BlockHeader)` with all transactions that were successfully added to a block before the proposal is published.

### Changes to P2P Interactions

The file `/yarn-project/p2p/src/client/p2p_client.ts` is where the P2P subsystem interacts with the transaction pool. Notably through the event handlers `handleFinalizedL2Blocks` and `handlePruneL2Blocks` . Note that under the new design, some of the work being done here moves to handlers in the transaction pool. This is desired. We want the transaction pool to own the logic as to what happens to transactions on a prune etc. There are also many places where the pool is queried for certain information.

The file `/yarn-project/p2p/src/services/libp2p/libp2p_service.ts` contains the code where we handle gossiped transactions, notably the `handleGossipedTx` function. This is where we need to make some changes. We will need to alter the process by which we validate and add transactions to the pool.

1. We will want to perform the very basic validations as soon as we see a transaction.
2. If these fail, we reject it and penalise the peer.
3. If these succeed, we call `canAdd`. If this fails we handle the response, either ignoring the transaction with no penalty, or rejecting it with a penalty.
4. Then we perform the expensive validations (the proof verification). If this fails we reject and penalise.
5. Finally, we call `addPendingTxs` and like step 3, we process the result.

We will want to use our newly defined validators.
