# Aztec.nr Overview

A comprehensive guide for developers and security reviewers to understand the Aztec.nr framework.

## Table of Contents

1. [What is Aztec.nr?](#what-is-aztecnr)
2. [Why Does Aztec.nr Exist?](#why-does-aztecnr-exist)
3. [Core Concepts](#core-concepts)
4. [Execution Contexts](#execution-contexts)
5. [State Management](#state-management)
6. [The Note Model](#the-note-model)
7. [Cross-Contract Communication](#cross-contract-communication)
8. [Authentication and Authorization](#authentication-and-authorization)
9. [Events and Messaging](#events-and-messaging)
10. [Cryptographic Infrastructure](#cryptographic-infrastructure)
11. [Oracle System](#oracle-system)
12. [The Macro System](#the-macro-system)
13. [Security Considerations](#security-considerations)
14. [Module Reference](#module-reference)

---

## What is Aztec.nr?

Aztec.nr is a **Noir framework for writing smart contracts on Aztec** - a privacy-first Layer 2 on Ethereum. It provides:

- **State variable abstractions** that hide the complexity of Aztec's UTXO-based private state model
- **Execution contexts** that manage interactions between contracts and the protocol
- **Cryptographic utilities** for encryption, key management, and authentication
- **Macro-based code generation** that transforms simple contract code into kernel-compatible circuits

Think of Aztec.nr as the equivalent of Solidity's standard library + OpenZeppelin + EVM opcodes, all bundled together. It bridges the gap between writing intuitive contract logic and the complex requirements of a privacy-preserving blockchain.

### Noir vs Aztec.nr

| Aspect        | Vanilla Noir                      | Aztec.nr                                        |
| ------------- | --------------------------------- | ----------------------------------------------- |
| Purpose       | General-purpose provable programs | Aztec smart contracts                           |
| State         | No built-in state management      | Full state variable system                      |
| Compilation   | Single ACIR circuit               | Multiple circuits per contract + AVM bytecode   |
| Public Inputs | Developer-defined                 | Protocol-specified (PrivateCircuitPublicInputs) |
| Verification  | Custom verifier                   | Aztec protocol handles verification             |

---

## Why Does Aztec.nr Exist?

### The Privacy Problem

Traditional smart contracts (like Ethereum) are fully transparent. Every transaction, every state change, every balance is publicly visible. This is fundamentally incompatible with many real-world use cases:

- Financial transactions should be private
- Medical records must be confidential
- Business logic often contains trade secrets

### The Complexity Problem

Building a privacy-preserving smart contract platform requires:

1. **Client-side execution** - Private functions run on user devices, not sequencers
2. **Zero-knowledge proofs** - Prove correctness without revealing data
3. **UTXO-based state** - Notes instead of account balances
4. **Kernel circuits** - Protocol-level verification of all operations
5. **Key management** - Multiple key types for different purposes

Without Aztec.nr, developers would need to:

- Manually construct circuit public inputs matching the kernel spec
- Implement their own note encryption/decryption
- Handle commitment schemes and nullifier generation
- Manage side-effect counters and call stacks
- Build state variable abstractions from scratch

**Aztec.nr abstracts all of this away**, letting developers write contracts that look almost like traditional smart contracts while automatically handling the underlying complexity.

---

## Core Concepts

### Contract Structure

An Aztec contract consists of:

```noir
#[aztec]
pub contract MyContract {
    // Storage declaration
    #[storage]
    struct Storage<Context> {
        public_value: PublicMutable<Field, Context>,
        private_balances: Owned<PrivateSet<TokenNote, Context>, Context>,
    }

    // External functions (entry points)
    #[external("private")]
    fn transfer(...) { ... }

    #[external("public")]
    fn update_config(...) { ... }

    #[external("utility")]
    unconstrained fn get_balance(...) -> u128 { ... }

    // Internal functions (inlined)
    #[internal("private")]
    fn _validate_inputs(...) { ... }
}
```

### The `contract` Keyword

The `contract` keyword is **built into Noir itself**, not provided by Aztec.nr. It creates a module with `is_contract = true`, which signals to the compiler that:

- Non-test functions are entry points
- Each entry point compiles as a separate circuit
- Comptime macros can detect contract modules via `Module::is_contract()`

### Function Types

| Attribute                | Execution Location            | State Access                           | Returns                      |
| ------------------------ | ----------------------------- | -------------------------------------- | ---------------------------- |
| `#[external("private")]` | User's device (client-side)   | Private notes, historical public state | `PrivateCircuitPublicInputs` |
| `#[external("public")]`  | Sequencer (AVM)               | Current public state                   | AVM return data              |
| `#[external("utility")]` | User's device (unconstrained) | Read private notes, query public state | Any type                     |
| `#[internal("private")]` | Inlined into caller           | Inherited from caller                  | Any type                     |
| `#[internal("public")]`  | Inlined into caller           | Inherited from caller                  | Any type                     |

---

## Execution Contexts

The **context** is the bridge between contract code and the Aztec protocol. It accumulates side effects, provides access to blockchain data, and constructs the outputs that kernel circuits verify.

### PrivateContext

**Location:** `aztec/src/context/private_context.nr`

The `PrivateContext` is the main interface for `#[external("private")]` functions. It:

**Provides access to:**

- `msg_sender()` - The calling contract (or null for first call)
- `this_address()` - The current contract's address
- `anchor_block_header` - Historical block for state proofs
- `chain_id`, `version`, `gas_settings` - Transaction metadata

**Accumulates side effects:**

- `note_hashes` - New notes being created
- `nullifiers` - Notes being consumed
- `note_hash_read_requests` - Proving note existence
- `nullifier_read_requests` - Proving nullifier existence/non-existence
- `private_call_requests` - Calls to other private functions
- `public_call_requests` - Enqueued public function calls
- `private_logs` - Encrypted messages and events
- `l2_to_l1_msgs` - Messages to L1

**Constructs:**

- `PrivateCircuitPublicInputs` - The final output that kernel circuits verify

### PublicContext

**Location:** `aztec/src/context/public_context.nr`

The `PublicContext` is used in `#[external("public")]` functions. Unlike private functions, public functions:

- Execute in the **AVM (Aztec Virtual Machine)** on the sequencer
- Access **current** public state (not historical)
- Compile to **AVM bytecode** (not ACIR circuits)
- Can **revert** (private functions cannot)

Key capabilities:

- Direct storage read/write via AVM opcodes
- Immediate visibility of other transactions' effects
- L1→L2 message consumption
- Public log emission

### UtilityContext

**Location:** `aztec/src/context/utility_context.nr`

The `UtilityContext` is for `#[external("utility")]` functions - unconstrained functions that run locally for queries and offchain operations:

- Read private notes from the user's PXE
- Query public state
- Perform note discovery and processing
- Return data to users/SDKs

---

## State Management

Aztec has two fundamentally different state models:

### Public State

Public state works similarly to Ethereum - key-value storage in a Merkle tree:

```noir
#[storage]
struct Storage<Context> {
    admin: PublicMutable<AztecAddress, Context>,
    total_supply: PublicMutable<u128, Context>,
    config: PublicImmutable<Config, Context>,
}
```

**State Variables:**

| Type                      | Mutability                     | Use Case                 |
| ------------------------- | ------------------------------ | ------------------------ |
| `PublicMutable<T>`        | Read/Write in public           | General mutable state    |
| `PublicImmutable<T>`      | Initialize once, read anywhere | Configuration, constants |
| `DelayedPublicMutable<T>` | Scheduled changes with delay   | Time-locked governance   |

### Private State

Private state uses the **UTXO (Unspent Transaction Output) model** via "notes":

```noir
#[storage]
struct Storage<Context> {
    balances: Owned<PrivateSet<TokenNote, Context>, Context>,
    owner_key: Owned<SinglePrivateMutable<SecretNote, Context>, Context>,
}
```

**Key insight:** Private state isn't stored as account balances. Instead:

1. Notes are created with encrypted data
2. Notes are committed to a global note hash tree
3. To "spend" a note, you prove it exists and emit a nullifier
4. Your "balance" is the sum of all your unspent notes

**State Variables:**

| Type                         | Behavior                          | Use Case                    |
| ---------------------------- | --------------------------------- | --------------------------- |
| `PrivateSet<Note>`           | Multiple notes, anyone can insert | Token balances, collections |
| `PrivateMutable<Note>`       | Single note, owner-only mutations | Private configs, secrets    |
| `PrivateImmutable<Note>`     | Set once, read forever            | Fixed private data          |
| `SinglePrivateMutable<Note>` | Like PrivateMutable but simpler   | Single owner secrets        |

### The `Owned` Wrapper

Private state variables must be wrapped in `Owned<T>`:

```noir
balances: Owned<PrivateSet<TokenNote, Context>, Context>,
```

This enforces that private state has an **owner** who controls read access. The owner's keys are used for:

- Encrypting note contents
- Computing nullifiers (proving ownership)
- Deriving storage slots for per-user state

### Map State Variable

`Map<K, V>` creates isolated storage slots per key:

```noir
balances: Map<AztecAddress, Owned<PrivateSet<TokenNote, Context>, Context>, Context>,
```

Each address gets its own independent `PrivateSet`.

---

## The Note Model

Notes are the fundamental building blocks of private state.

### Note Structure

```noir
#[note]
pub struct TokenNote {
    amount: u128,
    npk_m_hash: Field,  // Owner's master nullifier public key hash
    randomness: Field,  // Prevents brute-force attacks
}
```

### Note Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CREATE     │     │    EXIST     │     │   NULLIFY    │
│              │────▶│              │────▶│              │
│ - Compute    │     │ - In note    │     │ - Emit       │
│   note hash  │     │   hash tree  │     │   nullifier  │
│ - Emit to    │     │ - Can be     │     │ - Note is    │
│   kernel     │     │   proven     │     │   "spent"    │
│ - Encrypt &  │     │              │     │              │
│   deliver    │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

### Note Interface Traits

The `#[note]` macro generates implementations for:

```noir
pub trait NoteType {
    fn get_id() -> Field;  // Unique type identifier
}

pub trait NoteHash {
    fn compute_note_hash(self, owner, storage_slot, randomness) -> Field;
    fn compute_nullifier(self, context, owner, note_hash) -> Field;
    unconstrained fn compute_nullifier_unconstrained(...) -> Field;
}
```

### Note Privacy

Notes provide privacy through:

1. **Commitment hiding** - Note hashes reveal nothing about contents
2. **Nullifier unlinkability** - Nullifiers can't be linked to note hashes
3. **Encrypted delivery** - Note contents encrypted to recipient
4. **Randomness** - Prevents brute-force attacks on known values

---

## Cross-Contract Communication

### Private → Private Calls

```noir
self.call(OtherContract::at(address).private_function(args));
```

Private calls:

- Execute immediately (same proof)
- Share the same transaction context
- Return values can be used synchronously

### Private → Public Calls (Enqueued)

```noir
self.enqueue(OtherContract::at(address).public_function(args));
```

Public calls from private:

- **Cannot return values** (async execution)
- Execute later by the sequencer
- Can be hidden (`enqueue_incognito`) to not reveal the caller

### Public → Public Calls

```noir
self.call(OtherContract::at(address).public_function(args));
```

Direct calls executed in sequence.

### The Contract Interface

The `#[aztec]` macro generates an interface struct:

```noir
// Generated code
pub struct MyContract {
    target_contract: AztecAddress,
}

impl MyContract {
    pub fn at(address: AztecAddress) -> Self { ... }
    pub fn transfer(self, to: AztecAddress, amount: u128) -> PrivateCall<...> { ... }
}
```

This enables the ergonomic calling pattern: `MyContract::at(addr).transfer(to, amount)`

---

## Authentication and Authorization

### The Problem

Unlike Ethereum where `msg.sender` is always the transaction signer, Aztec has:

- Account abstraction (accounts are contracts)
- Multiple call layers
- Need to authorize actions across contracts

### AuthWit (Authentication Witness)

AuthWit is Aztec's solution for delegated authorization:

```
Alice wants DEX to transfer her tokens:

Alice Account ──▶ DEX.deposit() ──▶ Token.transfer(Alice→DEX)
                                         │
                                         ▼
                               Token asks: "Alice, is this OK?"
                                         │
                                         ▼
                               Alice Account validates signature
                                         │
                                         ▼
                               Token proceeds with transfer
```

**In private:** Alice signs a message hash, the signature is verified by her account contract via an oracle call.

**In public:** The approval is stored in a registry (the Auth Registry contract), and checked during execution.

### Key Functions

```noir
// In the contract requiring authorization
if !from.eq(context.msg_sender().unwrap()) {
    assert_current_call_valid_authwit(&mut context, from);
}

// The message being authorized includes:
// - Consumer (Token contract)
// - Chain ID and version
// - Inner hash (caller + function + args)
```

### The `#[authorize_once]` Macro

```noir
#[authorize_once("from", "nonce")]
#[external("private")]
fn transfer_from(from: AztecAddress, to: AztecAddress, amount: u128, nonce: Field) {
    // AuthWit check is automatically injected
}
```

---

## Events and Messaging

### Private Events

Private events are encrypted and delivered to specific recipients:

```noir
#[event]
struct Transfer { from: AztecAddress, to: AztecAddress, amount: u128 }

#[external("private")]
fn transfer(...) {
    let message = self.emit(Transfer { from, to, amount });
    message.deliver_to(from, MessageDelivery.OFFCHAIN);
    message.deliver_to(to, MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

**Delivery modes:**
| Mode | Storage | Encryption Constrained | Use Case |
|------|---------|----------------------|----------|
| `OFFCHAIN` | Off-chain | No | Sender incentivized to deliver |
| `ONCHAIN_UNCONSTRAINED` | Private log | No | Need backups, sender incentivized |
| `ONCHAIN_CONSTRAINED` | Private log | Yes | Untrusted sender |

### Public Events

Public events are emitted as plaintext logs (like Ethereum events):

```noir
#[external("public")]
fn update(...) {
    self.emit(ConfigUpdated { new_value });
}
```

### L1 ↔ L2 Messaging

**L1 → L2:**

```noir
// In private context
let content = context.consume_l1_to_l2_message(
    portal_address,
    content_hash,
    secret,
    leaf_index
);
```

**L2 → L1:**

```noir
context.message_portal(portal_address, content);
```

---

## Cryptographic Infrastructure

### Key Types

Aztec uses multiple key types for different purposes:

| Key                                      | Purpose                          | Who Knows   |
| ---------------------------------------- | -------------------------------- | ----------- |
| **Master Nullifier Key (nsk_m)**         | Derive nullifiers to spend notes | Owner only  |
| **Master Incoming Viewing Key (ivsk_m)** | Decrypt incoming notes           | Owner, apps |
| **Master Outgoing Viewing Key (ovsk_m)** | Decrypt sent notes               | Owner       |
| **Master Tagging Key (tsk_m)**           | Index encrypted messages         | Owner       |
| **Address Key**                          | Derive shared secrets            | Public      |

### Key Derivation

App-specific keys are derived from master keys:

```
app_nullifier_key = derive(nsk_m, contract_address)
```

This "app siloing" means:

- Contracts never see master keys
- Keys are specific to each contract
- Compromising one app doesn't compromise all

### ECDH Key Exchange

For encryption, Aztec uses Grumpkin curve ECDH:

```noir
let shared_secret = ecdh::derive_shared_secret(ephemeral_sk, recipient_pk);
let encryption_key = derive_encryption_key(shared_secret);
```

---

## Oracle System

Oracles provide external data to private functions during execution.

**Location:** `aztec/src/oracle/`

### What Are Oracles?

Private functions execute on the user's device in an unconstrained environment (the PXE - Private Execution Environment). They need access to:

- The user's private notes
- Historical blockchain state
- User secrets and keys
- External services

Oracles are the interface between the constrained circuit and the unconstrained execution environment.

### Key Oracles

| Oracle                   | Purpose                            |
| ------------------------ | ---------------------------------- |
| `notes`                  | Fetch/query notes from PXE         |
| `storage`                | Read public storage (historical)   |
| `get_block_header_at`    | Fetch historical block headers     |
| `auth_witness`           | Retrieve authentication witnesses  |
| `key_validation_request` | Request key validation from kernel |
| `execution_cache`        | Store/retrieve data for kernel     |
| `logs`                   | Emit private logs                  |
| `call_private_function`  | Invoke nested private calls        |
| `random`                 | Generate randomness                |

### Oracle Safety

Oracles return **unconstrained** data that must be validated:

- Note existence is proven against the note hash tree
- Public storage is proven against state roots
- Keys are validated by kernel circuits

Never trust oracle data without proof!

---

## The Macro System

The `#[aztec]` macro performs extensive code generation. See `aztec_macro.md` for full details.

### What It Generates

1. **Entry point wrappers** (`__aztec_nr_internals__*`)

   - Context initialization
   - Storage setup
   - Security checks
   - Return value handling

2. **Contract interface** (`ContractName::at(addr).function(args)`)

   - Enables cross-contract calls
   - Computes function selectors

3. **Self-call structs** (`CallSelf`, `EnqueueSelf`, etc.)

   - Type-safe internal dispatch

4. **ABI exports**

   - Preserve function signatures for tooling

5. **Public dispatch**

   - Routes public calls by selector

6. **Utility functions**
   - `sync_private_state`
   - `process_message`
   - `_compute_note_hash_and_nullifier`

### Supporting Macros

| Macro            | Applied To     | Purpose                                   |
| ---------------- | -------------- | ----------------------------------------- |
| `#[storage]`     | Storage struct | Generate initialization, slot computation |
| `#[note]`        | Note struct    | Generate NoteType, NoteHash traits        |
| `#[event]`       | Event struct   | Generate EventInterface, selector         |
| `#[external]`    | Functions      | Mark as entry points                      |
| `#[internal]`    | Functions      | Mark as inlinable                         |
| `#[view]`        | Functions      | Enforce static execution                  |
| `#[initializer]` | Functions      | Enforce single initialization             |
| `#[only_self]`   | Functions      | Restrict to self-calls only               |

---

## Security Considerations

### For Contract Developers

1. **Never trust unconstrained data without proof**

   - Oracle returns must be validated
   - Use provided library functions that handle proofs

2. **Nullifier uniqueness**

   - Nullifiers must be unique per note
   - Include randomness and owner-specific data

3. **Note commitment hiding**

   - Include sufficient randomness
   - Don't leak note contents through side channels

4. **Authorization checks**

   - Always verify `msg_sender()` for privileged operations
   - Use `#[only_self]` for internal callbacks
   - Implement proper AuthWit flows

5. **Initialization**
   - Use `#[initializer]` for constructor-like functions
   - Check `#[noinitcheck]` usage carefully

### For Security Reviewers

1. **Macro-generated code**

   - Use `nargo expand` to see actual compiled code
   - Verify security checks are properly injected

2. **Context handling**

   - Verify context is properly passed and not bypassed
   - Check that side effects are properly constrained

3. **Note lifecycle**

   - Verify notes are properly nullified when spent
   - Check for note hash/nullifier collision possibilities

4. **Key management**

   - Ensure app-siloed keys are properly derived
   - Verify key validation requests are made

5. **Cross-contract calls**

   - Check for reentrancy possibilities
   - Verify return value handling

6. **Public/private boundaries**
   - Information leakage through public function calls
   - Proper handling of enqueued calls

---

## Module Reference

### Core Modules

```
aztec/src/
├── context/           # Execution contexts
│   ├── private_context.nr   # PrivateContext - private function interface
│   ├── public_context.nr    # PublicContext - public function interface
│   ├── utility_context.nr   # UtilityContext - unconstrained queries
│   ├── calls.nr             # Call type definitions
│   └── inputs.nr            # Context input types
│
├── state_vars/        # State variable implementations
│   ├── public_mutable.nr        # Mutable public state
│   ├── public_immutable.nr      # Immutable public state
│   ├── private_set.nr           # Set of private notes
│   ├── private_mutable.nr       # Single mutable private note
│   ├── private_immutable.nr     # Single immutable private note
│   ├── map.nr                   # Key-value mapping
│   ├── owned.nr                 # Owner wrapper for private state
│   └── delayed_public_mutable.nr # Time-delayed mutations
│
├── note/              # Note system
│   ├── note_interface.nr    # NoteType, NoteHash traits
│   ├── lifecycle.nr         # create_note, destroy_note
│   ├── note_getter.nr       # Query notes
│   └── note_message.nr      # Note message delivery
│
├── authwit/           # Authentication witnesses
│   ├── auth.nr              # Core authwit functions
│   ├── account.nr           # Account contract interface
│   └── entrypoint.nr        # Transaction entry points
│
├── history/           # Historical proofs
│   ├── note_inclusion.nr        # Prove note exists
│   ├── nullifier_inclusion.nr   # Prove nullifier exists
│   ├── nullifier_non_inclusion.nr # Prove nullifier doesn't exist
│   └── public_storage.nr        # Prove historical public state
│
├── oracle/            # External data interface
│   ├── notes.nr             # Note queries
│   ├── storage.nr           # Storage queries
│   ├── auth_witness.nr      # Auth witness retrieval
│   └── ...                  # Many more oracles
│
├── event/             # Event system
│   ├── event_interface.nr   # EventInterface trait
│   ├── event_emission.nr    # Emit events
│   └── event_message.nr     # Event delivery
│
├── messages/          # Messaging system
│   ├── encryption/          # Message encryption
│   ├── discovery/           # Note/message discovery
│   └── message_delivery.nr  # Delivery modes
│
├── keys/              # Key management
│   ├── getters.nr           # Key retrieval
│   └── ephemeral.nr         # Ephemeral key generation
│
├── macros/            # Compile-time code generation
│   ├── aztec.nr             # Main #[aztec] macro
│   ├── storage.nr           # #[storage] macro
│   ├── notes.nr             # #[note] macro
│   └── functions/           # Function attribute macros
│
├── contract_self.nr   # ContractSelf struct (injected as `self`)
├── hash.nr            # Hashing utilities
└── messaging.nr       # L1↔L2 messaging
```

### Helper Libraries

```
aztec-nr/
├── uint-note/         # UintNote - store private u128
├── field-note/        # FieldNote - store private Field
├── address-note/      # AddressNote - store private AztecAddress
└── balance-set/       # BalanceSet - convenient balance management
```

---

## Getting Started

1. **Read the [aztec_macro.md](./aztec_macro.md)** to understand how contracts are transformed
2. **Study example contracts** in `noir-projects/noir-contracts/contracts/`
3. **Review protocol types** in `noir-projects/noir-protocol-circuits/crates/types/`
4. **Understand kernel circuits** to know what gets verified
5. **Use `nargo expand`** to see generated code when debugging

---

## Further Reading

- [Aztec Documentation](https://docs.aztec.network)
- [Noir Language](https://noir-lang.org)
- [Protocol Specification](https://docs.aztec.network/protocol-specs)
- [Yellow Paper](https://aztec.network/yellow-paper)
