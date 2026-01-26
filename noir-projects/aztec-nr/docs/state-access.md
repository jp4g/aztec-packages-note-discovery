# State Access in Aztec

This document explains how Aztec smart contracts read and write blockchain state, including the critical concepts of historical state, merkle proofs, and the differences between private and public execution.

## Table of Contents

1. [Overview](#overview)
2. [The Fundamental Challenge](#the-fundamental-challenge)
3. [World State Trees](#world-state-trees)
4. [The Anchor Block Header](#the-anchor-block-header)
5. [Private State Access](#private-state-access)
6. [Public State Access](#public-state-access)
7. [Historical Proofs](#historical-proofs)
8. [Read Requests vs Direct Reads](#read-requests-vs-direct-reads)
9. [State Variables and Storage Slots](#state-variables-and-storage-slots)
10. [Security Considerations](#security-considerations)

---

## Overview

Aztec has a fundamentally different state model than Ethereum:

| Aspect       | Ethereum      | Aztec Private    | Aztec Public    |
| ------------ | ------------- | ---------------- | --------------- |
| Execution    | Sequencer     | User's device    | Sequencer (AVM) |
| State access | Current state | Historical state | Current state   |
| Verification | Re-execution  | ZK proof         | ZK proof (AVM)  |
| State model  | Account-based | UTXO (notes)     | Key-value       |

The key insight is that **private functions cannot access current state** - they can only prove statements about historical state using merkle proofs against the anchor block header.

---

## The Fundamental Challenge

### Why Private Functions Can't See Current State

When you execute a private function:

1. **Execution happens on your device** - not on a sequencer that has the current blockchain state
2. **You generate a ZK proof** - which proves your execution was correct given some inputs
3. **The proof is submitted later** - potentially many blocks after you generated it

Between when you execute and when your transaction is included:

- Other transactions may have modified state
- Notes you read may have been nullified
- Public storage may have changed

**Solution:** Private functions don't read "current" state. Instead, they read from a **fixed historical snapshot** (the anchor block) and generate proofs against that snapshot. The kernel circuits then verify these proofs.

### The Time Gap Problem

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Timeline                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Block N-5    Block N-3    Block N    Block N+1   Block N+2   Block N+3     │
│     │            │            │           │           │           │          │
│     │            │            │           │           │           │          │
│     ▼            ▼            ▼           ▼           ▼           ▼          │
│  ┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐       │
│  │      │    │      │    │Anchor│    │      │    │  TX  │    │      │       │
│  │      │    │      │    │Block │    │      │    │Incl. │    │      │       │
│  └──────┘    └──────┘    └──────┘    └──────┘    └──────┘    └──────┘       │
│                               │                       │                      │
│                               │   User executes       │                      │
│                               │   private function    │                      │
│                               │   and generates proof │                      │
│                               └──────────────────────►│                      │
│                                                       │                      │
│                                   State at anchor     │                      │
│                                   block is used for   │                      │
│                                   merkle proofs       │                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## World State Trees

Aztec maintains several merkle trees that store all blockchain state:

### Tree Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BlockHeader                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  last_archive ──────────► Archive Tree (history of block headers)           │
│                                                                              │
│  state ─────────────────► StateReference                                    │
│                              │                                               │
│                              ├─► l1_to_l2_message_tree (L1→L2 messages)     │
│                              │                                               │
│                              └─► partial (PartialStateReference)            │
│                                     │                                        │
│                                     ├─► note_hash_tree (note commitments)   │
│                                     │                                        │
│                                     ├─► nullifier_tree (spent notes)        │
│                                     │                                        │
│                                     └─► public_data_tree (public storage)   │
│                                                                              │
│  global_variables ──────► block_number, timestamp, chain_id, etc.           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tree Purposes

| Tree                   | Contents                         | Used For                                          |
| ---------------------- | -------------------------------- | ------------------------------------------------- |
| **Note Hash Tree**     | Commitments to all created notes | Proving notes exist                               |
| **Nullifier Tree**     | All emitted nullifiers           | Proving notes are spent / preventing double-spend |
| **Public Data Tree**   | Public storage key-value pairs   | Reading historical public storage                 |
| **L1→L2 Message Tree** | Messages from Ethereum           | Cross-chain communication                         |
| **Archive Tree**       | Historical block headers         | Accessing any past block's state                  |

### Tree Properties

**Append-Only Trees** (Note Hash, L1→L2 Message, Archive):

- New entries are only appended
- Entries are never modified or deleted
- Proof = merkle inclusion proof

**Indexed Trees** (Nullifier, Public Data):

- Entries are sorted and linked
- Can prove both inclusion AND non-inclusion
- Each leaf has a pointer to the next leaf
- Used for "low nullifier" proofs

---

## The Anchor Block Header

### What is It?

The **anchor block header** is a specific historical block header that private functions use as their reference point for all state proofs. It's stored in `context.anchor_block_header`.

**Location:** `noir-projects/noir-protocol-circuits/crates/types/src/abis/block_header.nr`

```noir
pub struct BlockHeader {
    pub last_archive: AppendOnlyTreeSnapshot,  // Archive tree root
    pub state: StateReference,                  // All state tree roots
    pub sponge_blob_hash: Field,               // Tx effects commitment
    pub global_variables: GlobalVariables,      // Block metadata
    pub total_fees: Field,
    pub total_mana_used: Field,
}
```

### Why "Anchor"?

The name "anchor" indicates that:

1. All private execution is "anchored" to this specific block's state
2. All merkle proofs are verified against this block's tree roots
3. The transaction is valid only if the anchor block is recent enough

### Constraints on the Anchor Block

1. **Must be in the archive tree**: The anchor block must exist in the archive tree that the including checkpoint builds on. This is validated via a merkle membership proof in the rollup circuits (`private_tail_validator.nr`). The archive tree includes blocks from the **pending chain**, not just proven blocks. However, if a pending checkpoint gets pruned (due to proof deadline expiration), any anchor blocks from that checkpoint would no longer be in the archive tree for subsequent checkpoints.
2. **Must be recent**: The anchor block must be within the last ~24 hours (MAX_INCLUDE_BY_TIMESTAMP_DURATION)
3. **Determines validity window**: Your transaction must be included within 24 hours of the anchor block's timestamp
4. **User's choice**: The user/PXE is free to choose any anchor block that satisfies these constraints. Different anchor blocks may have different tradeoffs (e.g., more recent = fresher state but smaller inclusion window).

**Caution:** If you use an anchor block from a pending checkpoint that hasn't been proven yet, and that checkpoint gets pruned (due to proof deadline expiration), your transaction will fail during rollup processing. In practice, the PXE should select anchor blocks from proven checkpoints for safety.

```noir
// From private_context.nr
let max_allowed_include_by_timestamp = inputs.anchor_block_header.global_variables.timestamp
    + MAX_INCLUDE_BY_TIMESTAMP_DURATION;
```

### Accessing the Anchor Block

```noir
#[external("private")]
fn my_function(context: &mut PrivateContext) {
    // Get the anchor block header
    let header = context.get_anchor_block_header();

    // Access tree roots for proofs
    let note_hash_root = header.state.partial.note_hash_tree.root;
    let nullifier_root = header.state.partial.nullifier_tree.root;
    let public_data_root = header.state.partial.public_data_tree.root;

    // Access block metadata
    let block_number = header.global_variables.block_number;
    let timestamp = header.global_variables.timestamp;
}
```

---

## Private State Access

### Reading Notes

Private state is stored as **notes** - encrypted data commitments in the note hash tree.

```noir
#[external("private")]
fn get_balance(context: &mut PrivateContext, owner: AztecAddress) -> u128 {
    // 1. Query notes from PXE (unconstrained oracle call)
    let options = NoteGetterOptions::new();
    let notes = self.storage.balances.at(owner).get_notes(context, options);

    // 2. For each note, the framework:
    //    - Computes the note hash
    //    - Creates a read request proving the note exists
    //    - Adds it to context.note_hash_read_requests

    // 3. Sum up the values
    let mut total = 0;
    for note in notes {
        total += note.note.amount;
    }
    total
}
```

**Under the hood:**

1. Oracle fetches encrypted notes from PXE database
2. Notes are decrypted using the user's viewing key
3. For each note, a `NoteHashRead` is created containing the note hash
4. The kernel circuit later verifies each note hash exists in the note hash tree

### Note Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Note Lifecycle                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. CREATE                        2. EXISTS                  3. NULLIFY     │
│  ────────                         ────────                   ─────────      │
│                                                                              │
│  Note created in TX               Note hash in               Nullifier      │
│  ↓                                note_hash_tree             emitted        │
│  note_hash = hash(                ↓                          ↓              │
│    packed_note,                   Can be read by             Can't be       │
│    storage_slot,                  owner (encrypted)          spent again    │
│    randomness                     ↓                                         │
│  )                                Owner proves                              │
│  ↓                                inclusion via                             │
│  Siloed by contract               merkle proof                              │
│  ↓                                                                          │
│  Added to tree                                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Reading Historical Public Storage

Private functions can read public storage, but only from the anchor block:

```noir
use crate::history::public_storage::PublicStorageHistoricalRead;

#[external("private")]
fn check_config(context: &mut PrivateContext) -> Field {
    let header = context.get_anchor_block_header();

    // Read public storage at the anchor block
    let value = header.public_storage_historical_read(
        STORAGE_SLOT,
        context.this_address()
    );

    value
}
```

**How it works (`history/public_storage.nr`):**

1. Compute the public data tree leaf index: `hash(contract_address, storage_slot)`
2. Oracle provides a membership witness (leaf preimage + merkle path)
3. Verify the witness against `anchor_block_header.state.partial.public_data_tree.root`
4. Return the value (or 0 if the slot was never written)

```noir
impl PublicStorageHistoricalRead for BlockHeader {
    fn public_storage_historical_read(self, storage_slot: Field, contract_address: AztecAddress) -> Field {
        // Compute leaf index
        let public_data_tree_index = poseidon2_hash_with_separator(
            [contract_address.to_field(), storage_slot],
            DOM_SEP__PUBLIC_LEAF_INDEX
        );

        // Get witness from oracle
        let witness = unsafe {
            get_public_data_witness(self.global_variables.block_number, public_data_tree_index)
        };

        // Verify merkle proof
        assert_eq(
            self.state.partial.public_data_tree.root,
            root_from_sibling_path(witness.leaf_preimage.hash(), witness.index, witness.path)
        );

        // Return value (handling uninitialized slots)
        // ...
    }
}
```

---

## Public State Access

### Current State Access

Public functions run on the sequencer and have access to the **current** state (the tip of the chain):

```noir
#[external("public")]
fn update_balance(context: PublicContext, amount: u128) {
    // Direct storage read (current state)
    let current: u128 = context.storage_read(BALANCE_SLOT);

    // Direct storage write
    context.storage_write(BALANCE_SLOT, current + amount);
}
```

**Under the hood**, these compile to AVM opcodes:

- `SLOAD` - Read from public data tree
- `SSTORE` - Write to public data tree

### Checking Note/Nullifier Existence

Public functions can check if notes or nullifiers exist at the current state:

```noir
#[external("public")]
fn verify_nullifier_exists(context: PublicContext, nullifier: Field) {
    // Check nullifier existence at current tip
    let exists = context.nullifier_exists_unsafe(nullifier, context.this_address());
    assert(exists, "Nullifier not found");
}
```

**Important:** This checks the **current** nullifier tree, which may differ from what was true at the anchor block.

### L1→L2 Message Consumption

```noir
#[external("public")]
fn process_deposit(context: PublicContext, content: Field, secret: Field, sender: EthAddress, leaf_index: Field) {
    // Consumes the message (emits nullifier to prevent re-use)
    context.consume_l1_to_l2_message(content, secret, sender, leaf_index);
}
```

---

## Historical Proofs

The `history/` module provides utilities for proving statements about historical state.

### Note Inclusion

Prove a note exists in the note hash tree at the anchor block:

```noir
use crate::history::note_inclusion::ProveNoteInclusion;

#[external("private")]
fn prove_i_own_note(context: &mut PrivateContext, note: RetrievedNote<MyNote>) {
    let header = context.get_anchor_block_header();
    header.prove_note_inclusion(note);
}
```

### Nullifier Inclusion

Prove a nullifier exists (a note has been spent):

```noir
use crate::history::nullifier_inclusion::ProveNullifierInclusion;

#[external("private")]
fn prove_note_was_spent(context: &mut PrivateContext, nullifier: Field) {
    let header = context.get_anchor_block_header();
    header.prove_nullifier_inclusion(nullifier);
}
```

### Nullifier Non-Inclusion

Prove a nullifier does NOT exist (a note has not been spent):

```noir
use crate::history::nullifier_non_inclusion::ProveNullifierNonInclusion;

#[external("private")]
fn prove_note_not_spent(context: &mut PrivateContext, nullifier: Field) {
    let header = context.get_anchor_block_header();
    header.prove_nullifier_non_inclusion(nullifier);
}
```

**How non-inclusion works:**

The nullifier tree is an indexed merkle tree where each leaf points to the next. To prove a value is NOT in the tree:

1. Find the "low nullifier" - the largest value in the tree that is smaller than our target
2. Prove the low nullifier is in the tree
3. Prove the low nullifier's "next" pointer points past our target value

```
Nullifier Tree (simplified):
┌───────┐     ┌───────┐     ┌───────┐     ┌───────┐
│  10   │────►│  25   │────►│  50   │────►│  75   │
└───────┘     └───────┘     └───────┘     └───────┘

To prove 30 is NOT in the tree:
1. Find low nullifier = 25
2. Prove 25 is in the tree
3. 25's next is 50, and 30 < 50
4. Therefore 30 cannot be in the tree (it would be between 25 and 50)
```

### Contract Inclusion

Prove a contract is deployed:

```noir
use crate::history::contract_inclusion::ProveContractDeployment;

#[external("private")]
fn verify_contract_deployed(context: &mut PrivateContext, address: AztecAddress) {
    let header = context.get_anchor_block_header();
    header.prove_contract_deployment(address);
}
```

---

## Read Requests vs Direct Reads

### Read Requests (Private)

In private functions, state reads create **read requests** that are verified later by kernel circuits:

```noir
// When you call get_notes(), the framework creates read requests
let notes = self.storage.balances.get_notes(context, options);

// Each note generates a NoteHashRead:
pub struct NoteHashRead {
    pub note_hash: Field,           // The note's hash
    pub counter: u32,               // Side effect counter
}

// These are accumulated in context.note_hash_read_requests
// The kernel circuit verifies each one against the note hash tree
```

**Why this design?**

1. The private circuit doesn't have direct access to the merkle tree
2. The circuit just records "I read this note hash"
3. The kernel circuit (which has access to tree roots) verifies the claim

### Direct Reads (Public)

In public functions, reads are immediate via AVM opcodes:

```noir
// This directly executes SLOAD opcode
let value = context.storage_read(slot);
```

The AVM simulator/prover handles verification during execution.

---

## State Variables and Storage Slots

### Slot Computation

Each state variable has a unique storage slot computed during contract deployment:

```noir
#[storage]
struct Storage<Context> {
    admin: PublicMutable<AztecAddress, Context>,      // slot 1
    total_supply: PublicMutable<u128, Context>,       // slot 2
    balances: Map<AztecAddress, Owned<PrivateSet<TokenNote, Context>, Context>, Context>,  // slot 3
}
```

For `Map` types, the slot is derived per key:

```
actual_slot = hash(map_base_slot, key)
```

### Public Storage Layout

Public storage uses the public data tree with indexed leaves:

```
Leaf Index = hash(contract_address, storage_slot)

Leaf Preimage:
┌─────────────────────────────────────────┐
│ slot: Field        // The storage slot  │
│ value: Field       // The stored value  │
│ next_index: u32    // Index of next leaf│
│ next_slot: Field   // Slot of next leaf │
└─────────────────────────────────────────┘
```

### Private Storage (Notes)

Private storage doesn't use a key-value model. Instead:

- Notes are created with a storage slot
- Notes are found by querying the PXE for notes at a given slot
- The storage slot is part of the note hash computation

---

## Security Considerations

### Time-of-Check vs Time-of-Use (TOCTOU)

**The core issue:** What you prove in private (at the anchor block) may not be true when your transaction is included.

**Example vulnerability:**

```noir
#[external("private")]
fn withdraw_if_config_allows(context: &mut PrivateContext) {
    // Read config at anchor block
    let config = header.public_storage_historical_read(CONFIG_SLOT, address);

    // Check passes at anchor block...
    assert(config.withdrawals_enabled);

    // But config might be disabled by the time TX is included!
    self.storage.balance.remove_note(context, note);
}
```

**Mitigations:**

- Use `DelayedPublicMutable` for config that gates private actions
- Accept that private proofs are about historical state
- Design contracts to be safe despite the time gap

### Nullifier Non-Inclusion Caveats

**In private:** It's unsafe to rely on nullifier non-existence because:

- Another TX might emit that nullifier between anchor block and inclusion
- Instead, emit the nullifier yourself (TX fails if it already exists)

**In public:** Nullifier existence checks are safe because you're checking current state.

### Double-Spend Prevention

The protocol prevents double-spending through nullifiers:

1. Each note has a unique nullifier
2. Spending a note requires emitting its nullifier
3. The nullifier tree rejects duplicate nullifiers
4. Therefore, each note can only be spent once

### Information Leakage

Be careful about what you reveal through state access patterns:

- Public storage reads in private don't reveal which slot was read
- But enqueued public calls may reveal information
- Note selection patterns could leak information in some cases

---

## Summary

| Context | State Type                | Access Method          | Verification                              |
| ------- | ------------------------- | ---------------------- | ----------------------------------------- |
| Private | Notes                     | Oracle + read requests | Kernel verifies against anchor block      |
| Private | Historical public storage | Oracle + merkle proof  | Circuit verifies against anchor block     |
| Private | Nullifier existence       | Historical proof       | Against anchor block (unsafe for current) |
| Public  | Public storage            | AVM SLOAD/SSTORE       | AVM execution/proving                     |
| Public  | Nullifier existence       | AVM opcode             | Against current state                     |
| Public  | L1→L2 messages            | AVM opcode             | Against current state                     |

**Key takeaways:**

1. **Private = Historical**: All private state access is against the anchor block, not current state
2. **Public = Current**: Public functions see the tip of the chain
3. **Merkle proofs everywhere**: All state claims are backed by cryptographic proofs
4. **Read requests defer verification**: Private circuits record claims; kernels verify them
5. **Design for the time gap**: Private contracts must be safe despite the delay between execution and inclusion
