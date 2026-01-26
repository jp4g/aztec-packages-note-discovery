# Transaction Management Design

**Contributors**: Phil (Tech Lead), Nikola Mratinic
**Approvers**: Nikola Mratinic, Santiago Palladino
**Linear Project**: [Alpha Network Performance](https://linear.app/aztec-labs/project/alpha-network-performance-70eb00d71102/overview)

## Overview

Sequencers need transactions to build blocks. Validators and provers need those transactions to re-execute and prove those blocks. Transactions enter the network via RPC endpoints and propagate through a libp2p gossip network.

Unlike Ethereum, Aztec block proposals do not contain the transactions themselves (they're too large). Instead, validators retrieve transactions from their local pools or request them from peers. Additionally, transactions are needed during proving, which occurs after block validation, so they must persist longer than on Ethereum networks.

This document defines the transaction pool design, lifecycle states, validation pipeline, and eviction strategy. It distinguishes between **current implementation** and **proposed changes**.

---

## Current State

### Existing Transaction Pool (`AztecKVTxPool`)

**Location**: `p2p/src/mem_pools/tx_pool/aztec_kv_tx_pool.ts`

The current pool supports two states:
- **Pending**: Available for block building, can be evicted
- **Mined**: Included in a block, tracked by block number

**Current Interface** (simplified):
```typescript
interface TxPool {
  addTxs(txs: Tx[]): Promise<number>;                    // Returns count added
  markAsMined(hashes: TxHash[], header: BlockHeader): Promise<void>;
  markMinedAsPending(hashes: TxHash[], block: BlockNumber): Promise<void>;
  deleteTxs(hashes: TxHash[]): Promise<void>;
  markTxsAsNonEvictable(hashes: TxHash[]): Promise<void>;
  clearNonEvictableTxs(): Promise<void>;
  getPendingTxHashes(): Promise<TxHash[]>;
  // ... query methods
}
```

### Existing Eviction Rules

**Location**: `p2p/src/mem_pools/tx_pool/eviction/`

| Rule                              | Trigger                          | Behavior                                                     |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| `LowPriorityEvictionRule`         | Pool exceeds `maxPendingTxCount` | Evicts lowest-priority pending txs                           |
| `InvalidTxsAfterMiningRule`       | Block mined                      | Evicts txs with conflicting nullifiers or expired timestamps |
| `InvalidTxsAfterReorgRule`        | Chain pruned                     | Evicts txs referencing pruned blocks                         |
| `InsufficientFeePayerBalanceRule` | Block mined or chain pruned      | Evicts txs whose fee payer has insufficient balance          |

### Existing Validators

**Location**: `p2p/src/msg_validators/tx_validator/`

All validators exist and are functional:

| Validator                | Cost   | What It Checks                               |
| ------------------------ | ------ | -------------------------------------------- |
| `SizeTxValidator`        | Low    | Transaction size limits                      |
| `TxPermittedValidator`   | Low    | Network accepts transactions                 |
| `DataTxValidator`        | Low    | Hash consistency, calldata integrity         |
| `MetadataTxValidator`    | Low    | Chain ID, rollup version, protocol contracts |
| `TimestampTxValidator`   | Low    | Not expired (`includeByTimestamp`)           |
| `DoubleSpendTxValidator` | Medium | No duplicate nullifiers                      |
| `GasTxValidator`         | Medium | Gas limits valid, fee payer has balance      |
| `PhasesTxValidator`      | Medium | Setup functions on allow list                |
| `BlockHeaderTxValidator` | Medium | References valid anchor block                |
| `TxProofValidator`       | High   | ZK proof verifies                            |

### Existing Gossip Flow

**Location**: `p2p/src/services/libp2p/libp2p_service.ts`

```
Tx received via gossip
    │
    v
[MessageSeenValidator: dedup check]
    │
    v
[All validators run sequentially]
    │
    ├── Invalid? → Reject + penalize peer
    v
[txPool.addTxs()]
    │
    v
Accept + propagate (if new)
```

Current limitations:
- No pre-flight check before expensive proof validation
- `addTxs()` returns count, not per-tx accept/reject/ignore status
- Non-evictable flag is binary, not slot-aware

### Existing Block Building Integration

**Location**: `sequencer-client/src/sequencer/checkpoint_proposal_job.ts`

- Proposer calls `iteratePendingTxs()` to get candidates
- `preprocessValidator` validates txs before execution
- Failed txs removed via `deleteTxs()`
- Successful txs marked via `markAsMined()` after block added to archiver

---

## Proposed Changes

### New Transaction State: Protected

Add a third state between Pending and Mined:

| State         | Description                                  | Evictable | Available for Block Building |
| ------------- | -------------------------------------------- | --------- | ---------------------------- |
| **Pending**   | Validated and waiting                        | Yes       | Yes                          |
| **Protected** | Reserved for a proposal in progress          | No        | No                           |
| **Mined**     | Included in a block that passed re-execution | No        | No                           |

**Rationale**: The current `markTxsAsNonEvictable()` is a binary flag without slot context. Transactions can be stuck as non-evictable if cleanup fails. Slot-based protection provides automatic expiration.

### State Transitions

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    v                                             │
[New Tx] ──> PENDING ──> PROTECTED ──> MINED ──> DELETED          │
                │              │          │                       │
                │              │          └──[chain prune]────────┘
                │              │                    │
                │              └──[proposal fails]──┤
                │                                   │
                └──[evicted/invalidated]──> DELETED │
                                                    v
                                               [L1 finalized]
```

### New Pool API

**Changes from current interface**:

```typescript
interface TxPool {
  // CHANGED: Returns per-tx result instead of count
  addPendingTxs(txs: Tx[]): Promise<AddResult[]>;

  // NEW: Pre-flight check before expensive validation
  canAddPendingTxs(txs: Tx[]): Promise<AddResult[]>;

  // NEW: Protect transactions for block execution
  addProtectedTxs(txs: Tx[], block: BlockHeader): Promise<void>;
  protectTxs(hashes: TxHash[], block: BlockHeader): Promise<TxHash[]>; // returns unavailable

  // RENAMED: markAsMined → handleMinedBlock (also invalidates conflicting pending txs)
  handleMinedBlock(txs: TxHash[], block: BlockHeader): Promise<void>;

  // NEW: Add mined transactions directly (for provers via req/resp)
  addMinedTxs(txs: Tx[]): Promise<void>;

  // NEW: Slot-based protection management
  prepareForSlot(slot: SlotNumber): Promise<void>;

  // RENAMED: More explicit handler names
  handlePrunedBlocks(latestBlock: L2BlockId): Promise<void>;
  handleFailedExecution(txs: TxHash[]): Promise<void>;
  handleFinalizedBlock(block: BlockHeader): Promise<void>;
}

// NEW: Three-result semantics
type AddResult =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: string }  // penalize peer
  | { status: 'ignored'; reason: string };   // no penalty
```

### New Gossip Validation Flow

**Key change**: Split validation into fast → canAdd → expensive → add

```
Tx received via gossip
    │
    v
[Fast validators: Size, Permitted, Data, Metadata]  ← Cheap, no state access
    │
    ├── Invalid? → Reject + penalize peer
    v
[canAddPendingTxs: check against pool state]  ← NEW: Pre-flight check
    │
    ├── Rejected? → Penalize peer
    ├── Ignored? → No penalty, don't propagate
    v
[Expensive validators: Proof]  ← Only run if tx is wanted
    │
    ├── Invalid? → Reject + penalize peer
    v
[addPendingTxs: insert into pool]
    │
    ├── Rejected? → Penalize peer (race condition)
    ├── Ignored? → Already present or evicted
    v
Accept + propagate
```

**Rationale**: Proof verification is expensive (~100ms). The `canAddPendingTxs` check prevents wasting CPU on unwanted transactions.

### Transaction Metadata (New In-Memory Approach)

**Change**: Currently all data in KV store. Proposed: metadata in memory, bodies on disk.

```typescript
type TxMetaData = {
  txHash: TxHash;
  anchorBlockHeaderHash: Fr;        // Block header the tx references
  priorityFee: bigint;              // Total priority fee (for ordering)
  feePayer: AztecAddress;           // For balance validation
  nullifiers: string[];             // For double-spend detection
  minedL2BlockId?: L2BlockId;       // Set when mined
  protectedSlotNumber?: SlotNumber; // NEW: Set when protected
};
```

State derived from metadata:
```typescript
if (meta.minedL2BlockId) return 'mined';
if (meta.protectedSlotNumber) return 'protected';
return 'pending';
```

**Memory estimate**: ~100MB for 95 minutes at 10 TPS (worst case).

### Protection Lifecycle

1. **Proposer builds block**: After execution, calls `addProtectedTxs(txs, block)` before broadcasting.

2. **Validators receive proposal**: Call `protectTxs(hashes, block)`. Returns unavailable hashes for req/resp retrieval.

3. **Slot advances**: `prepareForSlot(slot)` unprotects txs from earlier slots. They return to pending (re-validated) or are deleted.

4. **Block mined**: `handleMinedBlock()` moves protected → mined.

**Replaces**: Current `markTxsAsNonEvictable()` / `clearNonEvictableTxs()` pattern.

### Validator Reorganization

**Current state**: Validator factories scattered across:
- `validator-client/src/tx_validator/tx_validator_factory.ts`
- `p2p/src/msg_validators/tx_validator/factory.ts`
- `p2p/src/services/libp2p/libp2p_service.ts`

**Proposed**: Consolidate into composable sets:

| Set                | Validators                                       | Use Case                                    |
| ------------------ | ------------------------------------------------ | ------------------------------------------- |
| **Fast**           | Size, Permitted, Data, Metadata                  | First check on gossip (no state access)     |
| **State**          | Timestamp, DoubleSpend, Gas, Phases, BlockHeader | Pool insertion, block building              |
| **Expensive**      | Proof                                            | After canAdd passes                         |
| **Block-building** | State validators only                            | Proposer/validator (proof already verified) |
| **Req/resp**       | Size, Data, Metadata, Proof                      | Requested txs (minimal state checks)        |

---

## Implementation Checklist

### Phase 1: Pool API Changes

- [ ] Add `AddResult` type with accept/reject/ignore semantics
- [ ] Change `addTxs()` → `addPendingTxs()` returning `AddResult[]`
- [ ] Add `canAddPendingTxs()` pre-flight check
- [ ] Add `protectedSlotNumber` to metadata tracking
- [ ] Add `addProtectedTxs()` and `protectTxs()` handlers
- [ ] Add `prepareForSlot()` for slot transitions
- [ ] Add `addMinedTxs()` for prover-fetched transactions
- [ ] Rename handlers: `handleMinedBlock`, `handlePrunedBlocks`, `handleFailedExecution`, `handleFinalizedBlock`
- [ ] Deprecate `markTxsAsNonEvictable()` / `clearNonEvictableTxs()`

### Phase 2: Gossip Flow Changes

- [ ] Split validation into fast → canAdd → expensive → add
- [ ] Update `handleGossipedTx()` to use new flow
- [ ] Map `AddResult` to gossip accept/reject/ignore responses

### Phase 3: Block Building Changes

- [ ] Call `prepareForSlot()` at slot start
- [ ] Call `addProtectedTxs()` after successful block build
- [ ] Call `handleFailedExecution()` for failed txs

### Phase 4: Request/Response Changes

- [ ] Pass context to distinguish validator vs prover requests
- [ ] Use `addProtectedTxs()` for validator-fetched txs
- [ ] Use `addMinedTxs()` for prover-fetched txs

### Phase 5: Validator Consolidation

- [ ] Create composable validator sets in single location
- [ ] Update all integration points to use consolidated factories

---

## Comparison: Current vs Proposed

| Aspect                 | Current                      | Proposed                           |
| ---------------------- | ---------------------------- | ---------------------------------- |
| Transaction states     | 2 (Pending, Mined)           | 3 (Pending, Protected, Mined)      |
| Eviction protection    | Binary flag (`nonEvictable`) | Slot-based (`protectedSlotNumber`) |
| `addTxs` result        | Count added                  | Per-tx accept/reject/ignore        |
| Pre-flight check       | None                         | `canAddPendingTxs()`               |
| Proof validation       | Always before pool check     | After `canAddPendingTxs()`         |
| Metadata storage       | All in KV store              | In-memory with disk bodies         |
| Validator organization | Scattered across files       | Consolidated composable sets       |

## Comparison with Ethereum Clients

| Aspect              | Ethereum (Geth)  | Aztec (Current) | Aztec (Proposed)      |
| ------------------- | ---------------- | --------------- | --------------------- |
| Storage             | Memory only      | Disk (KV store) | Disk + memory indexes |
| Persistence         | Until included   | Until deleted   | Until L1 finalized    |
| Eviction protection | None             | Binary flag     | Slot-based            |
| Add result          | Boolean          | Count           | Per-tx status         |
| Pre-flight check    | Yes (pool space) | No              | Yes (state + space)   |

---

## Summary

This design proposes the following changes to address transaction management requirements:

1. **Protected state** (NEW) - Slot-aware eviction protection replacing binary flag
2. **Three-result semantics** (NEW) - Accept/reject/ignore for nuanced peer handling
3. **Pre-flight validation** (NEW) - `canAddPendingTxs()` to avoid wasted proof verification
4. **In-memory metadata** (NEW) - Faster queries with disk-backed bodies
5. **Consolidated validators** (REFACTOR) - Composable sets in single location
6. **Explicit handlers** (RENAME) - `handleMinedBlock`, `prepareForSlot`, etc.

The existing eviction rules, validators, and basic pool operations remain largely unchanged.
