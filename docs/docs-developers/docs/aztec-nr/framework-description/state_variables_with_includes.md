---
title: State Variables
sidebar_position: 3
tags: [contracts, storage, data-types, smart-contracts]
description: Define and manage storage state in your Aztec smart contracts using various storage types.
---

# State Variables

A contract's state is defined by multiple values, e.g. in a token it'd be the total supply, user balances, outstanding approvals, accounts with minting permission, etc. Each of these persisting values is called a _state variable_.

One of the first design considerations for any smart contract is how it'll store its state. This is doubly true in Aztec due to there being **both public and private state** - the tradeoff space is large, so there's room for lots of decisions.

## Choosing the right storage type

| Need | Use |
|------|-----|
| Public value anyone can read/write | `PublicMutable` |
| Public value set once (contract name, decimals) | `PublicImmutable` |
| Public key-value mapping | `Map<K, PublicMutable<V>>` |
| Private collection per user (token balances) | `Owned<PrivateSet<...>>` |
| Single private value per user | `Owned<PrivateMutable<...>>` |
| Immutable private value per user | `Owned<PrivateImmutable<...>>` |
| Contract-wide private singleton (admin key) | `SinglePrivateMutable` |
| Public value readable in private execution | `DelayedPublicMutable` |

## Prerequisites

- An Aztec contract project set up with `aztec-nr` dependency
- Understanding of Aztec's private and public state model
- Familiarity with Noir struct syntax

For storage concepts, see [storage overview](../../foundational-topics/state_management.md).

## The Storage Struct

State variables are declared in Solidity by simply listing them inside of the contract, like so:

```solidity
contract MyContract {
    uint128 public my_public_state_variable;
}
```

In Aztec.nr, we define a [`struct`](https://noir-lang.org/docs/noir/concepts/data_types/structs) that holds _all_ state variables. This struct is called **the storage struct**, and it is identified by having the `#[storage]` macro applied to it.

The storage struct can have _any_ name, but it is _typically_ named `Storage`. This struct must also have a generic type called `C` or `Context` - this is an unfortunate boilerplate parameter that provides execution mode information.

The `#[storage]` macro can only be used once so all contract state must be in a **single** struct.

Here's an example from the Token contract showing different types of state variables:

#include_code storage_struct /noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr rust

### Accessing Storage

The contract's storage is accessed via `self.storage` in any contract function. It will automatically be tailored to the execution context of that function, hiding all methods that cannot be invoked there.

Consider, for example, a `PublicMutable` state variable, which is a value that is fully accessible in public functions, read-only in utility functions and not accessible in a private function:

```rust
#[storage]
struct Storage<C> {
    my_public_variable: PublicMutable<u128, C>,
}

#[external("public")]
fn my_public_function() {
    let current = self.storage.my_public_variable.read();
    self.storage.my_public_variable.write(current + 1);
}

#[external("private")]
fn my_private_function() {
    let current = self.storage.my_public_variable.read(); // compilation error - 'read' is not available in private
    self.storage.my_public_variable.write(current + 1); // compilation error - 'write' is not available in private
}

#[external("utility")]
fn my_utility_function() {
    let current = self.storage.my_public_variable.read();
    self.storage.my_public_variable.write(current + 1); // compilation error - 'write' is not available in utility
}
```

## Public State Variables

These are state variables that have _public_ content: everyone on the network can see the values they store. They can be considered to be equivalent to Solidity state variables.

### Choosing a Public State Variable

Public state variables are stored in the network's public storage tree and they can only be written to by public contract functions. It is possible to read _historic_ values of a public state variable in a private contract function, but the current values in the network's public state tree are not accessible in private functions. This means that most public state variables cannot be read from a private function, though there are some exceptions that are documented in the table below.

Below is a table comparing the key properties of the different public state variables that Aztec.nr offers:

| State variable         | Mutable?            | Readable in private? | Writable in private? | Example use case                                                                   |
| ---------------------- | ------------------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `PublicMutable`        | yes                 | no                   | no                   | Configuration of admins, global state (e.g. token total supply, total votes)       |
| `PublicImmutable`      | no                  | yes                  | no                   | Fixed configuration, one-way actions (e.g. initialization settings for a proposal) |
| `DelayedPublicMutable` | yes (after a delay) | yes                  | no                   | Non time sensitive system configuration                                            |

### PublicMutable

`PublicMutable` is the simplest kind of public state variable: a value that can be read and written. It is essentially the same as a non-`immutable` or `constant` Solidity state variable.

It **cannot be read or written to privately**, but it is possible to call private functions that enqueue a public call in which a `PublicMutable` is accessed. For example, a voting contract may allow private submission of votes which then enqueue a public call in which the vote count, represented as a `PublicMutable<u128>`, is incremented. This would let anyone see how many votes have been cast, while preserving the privacy of the account that cast the vote.

#### Declaration

Store mutable public state using `PublicMutable<T>` for values that need to be updated throughout the contract's lifecycle.

#include_code public_storage /docs/examples/contracts/bob_token_contract/src/main.nr rust

:::note

Unlike private state which must be explicitly initialized, uninitialized `PublicMutable` returns the default value (zero for numbers, empty for addresses). This matches Ethereum's behavior.

:::

#### `read` and `write`

Example of reading and writing to a `PublicMutable` variable:

#include_code mint_public /docs/examples/contracts/bob_token_contract/src/main.nr rust

### PublicImmutable

`PublicImmutable` is a simplified version `PublicMutable`: it's a public state variable that can only be written (initialized) once, at which point it can only be read. Unlike Solidity `immutable` state variables, which must be set in the contract's constructor, a `PublicImmutable` can be initialized _at any point in time_ during the contract's lifecycle and attempts to read it prior to initialization will revert.

Due to the value being immutable, it is also possible to read it during private execution - once a circuit proves that the value was set in the past, it knows it cannot have possibly changed. This makes this state variable suitable for immutable public contract configuration or one-off public actions, such as whether a user has signed up or not.

#### Declaration and `initialize`

Here's an example from the Token contract initializing `PublicImmutable` variables in the constructor:

#include_code constructor /noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr rust

:::warning
A `PublicImmutable`'s storage **must** only be set once via `initialize`. Attempting to override this by manually accessing the underlying storage slots breaks all properties of the data structure, rendering it useless.
:::

#### `read`

Returns the stored immutable value. This function is available in public, private and utility contexts.

```rust
// In public
#[external("public")]
fn get_name() -> FieldCompressedString {
    self.storage.name.read()
}

// In private (reads from historical state)
#[external("private")]
fn get_name_private() -> FieldCompressedString {
    self.storage.name.read()
}

// In utility
#[external("utility")]
unconstrained fn get_name_unconstrained() -> FieldCompressedString {
    self.storage.name.read()
}
```

### DelayedPublicMutable

It is sometimes necessary to read public mutable state in private. For example, a decentralized exchange might have a configurable swap fee that some admin sets, but which needs to be read by users in their private swaps. This is where `DelayedPublicMutable` comes in.

`DelayedPublicMutable` is the same as a `PublicMutable` in that it is a public value that can be read and written, but with a caveat: writes only take effect _after some time delay_. These delays are configurable, but they're typically on the order of a couple hours, if not days, making this state variable unsuitable for actions that must be executed immediately - such as an emergency shut down. It is these very delays that enable private contract functions to _read the current value of a public state variable_, which is otherwise typically impossible.

The existence of minimum delays means that a private function that reads a public value at an anchor block has a guarantee that said historical value will remain the current value until _at least_ some time in the future - before the delay elapses. As long as the transaction gets included in a block before that time (by using the `include_by_timestamp` tx property), the read value is valid.

#### Declaration

Unlike other state variables, `DelayedPublicMutable` receives not only a type parameter for the underlying datatype, but also a `DELAY` type parameter with the value change delay as a number of seconds.

Here's an example from the Auth contract:

```rust
// Authorizing a new address has a certain delay before it goes into effect. Set to 180 seconds which is 5 slots.
pub(crate) global CHANGE_AUTHORIZED_DELAY: u64 = 180;

#[storage]
struct Storage<Context> {
    admin: PublicImmutable<AztecAddress, Context>,
    authorized: DelayedPublicMutable<AztecAddress, CHANGE_AUTHORIZED_DELAY, Context>,
}
```

Recommended standard delays:
- 12 hours = 43200 seconds - Time-sensitive operations
- 5 days = 432000 seconds - Standard operations
- 2 weeks = 1209600 seconds - Operations requiring lengthy public scrutiny

#### `schedule_value_change`

This is the means by which a `DelayedPublicMutable` variable mutates its contents. It schedules a value change for the variable at a future timestamp after the `DELAY` has elapsed.

```rust
#[external("public")]
fn set_authorized(authorized: AztecAddress) {
    assert_eq(self.storage.admin.read(), self.msg_sender().unwrap(), "caller is not admin");
    self.storage.authorized.schedule_value_change(authorized);
}
```

#### `get_current_value`

Returns the current value in a public, private or utility execution context.

#include_code public_getter /noir-projects/noir-contracts/contracts/app/auth_contract/src/main.nr rust

Reading in private automatically constrains the transaction to be included within the validity window:

```rust
#[external("private")]
fn do_private_authorized_thing() {
    let authorized = self.storage.authorized.get_current_value();
    assert_eq(authorized, self.msg_sender().unwrap(), "caller is not authorized");
}
```

:::warning Privacy Consideration

Reading `DelayedPublicMutable` in private sets the `include_by_timestamp` property, which may reveal timing information. Choose delays that align with common values to maximize privacy sets.

:::

#### `get_scheduled_value`

Returns the scheduled value and when it takes effect:

```rust
let (scheduled_value, effective_timestamp) = self.storage.authorized.get_scheduled_value();
```

## Private State Variables

Private state variables have _private_ content meaning that only some people know what is stored in them. These work _very_ differently from public state variables and are unlike anything in languages such as Solidity, since they are built from fundamentally different primitives (UTXO-based notes and nullifiers instead of a key-value updatable public database).

Aztec.nr provides three private state variable types:

- `Owned<PrivateMutable<NoteType, Context>, Context>`: Single mutable private value
- `Owned<PrivateImmutable<NoteType, Context>, Context>`: Single immutable private value
- `Owned<PrivateSet<NoteType, Context>, Context>`: Collection of private notes

These private state variables are "owned" and must be wrapped in the `Owned<>` container, which enables owner-specific access via the `.at(owner)` method. Each also requires a `NoteType`. To understand this, let's go through notes and nullifiers and how they can be used so we can understand how private state works.

### Notes and Nullifiers

Just as public state is stored in a single public data tree (equivalent to the `key-value` store used for state on the EVM), private state is stored in two separate trees:

- The note hash tree: stores hashes of the private data, called notes, which are just structs containing private data, with some methods.
- The nullifier tree: the nullifier for a certain note is deterministic and presence of the nullifier in the nullifier tree determines that the note has been spent/used.

#### Notes

Notes are user-defined data that can be stored privately on the blockchain. A note can represent any private data e.g., an amount (e.g. some token balance), an ID (e.g. a vote proposal Id) or an address (e.g. an authorized account).

They also have some metadata, including a storage slot to avoid collisions with other notes, a `randomness` value that helps hide the content, and an `owner` who can nullify the note.

The note content, plus the metadata, are all hashed together, and it is this hash that gets stored onchain in the note hash tree. This hash is called a commitment. The underlying note content (the note hash preimage) is not stored anywhere onchain, and so third parties cannot access it and it remains private.

Note: Aztec.nr comes with some prebuilt note types, including [`UintNote`](https://github.com/AztecProtocol/aztec-packages/tree/08935f75dbc3052ce984add225fc7a0dac863050/noir-projects/aztec-nr/uint-note) and [`AddressNote`](https://github.com/AztecProtocol/aztec-packages/tree/08935f75dbc3052ce984add225fc7a0dac863050/noir-projects/aztec-nr/address-note), but users are also free to create their own with the `#[note]` macro.

#### Nullifiers

A nullifier is a value which indicates a resource has been spent. Nullifiers are unique, and the protocol forbids the same nullifier from being inserted into the tree twice. Spending the same resource therefore results in a duplicate nullifier, which invalidates the transaction.

Most often, nullifiers are used to mark a note as being spent, which prevents note double spends. The nullifier is typically computed as a **hash of the note contents concatenated with a private key of the note's owner**. These values are **immutable**, and only the owner knows their private keys, ensuring both determinism and secrecy.

### Note Messages

When working with private state variables, many operations return a `NoteMessage<Note>` type rather than the note directly. This is a type-safe wrapper that ensures you explicitly decide how to deliver the note to its recipient.

#### Why NoteMessage?

Private notes need to be communicated to their recipients so they know the note exists and can use it. The `NoteMessage` wrapper forces you to make an explicit choice about how this happens:

- **`.deliver(MessageDelivery)`**: Delivers the note so the recipient can discover it. You must specify a `MessageDelivery` option:
  - `MessageDelivery.ONCHAIN_CONSTRAINED`: Verified in the circuit (most secure, but highest cost) - Use when the sender cannot be trusted to deliver correctly (e.g., protocol fees, multisig config updates). **Warning:** Currently [not fully constrained](https://github.com/AztecProtocol/aztec-packages/issues/14565) - the log's tag is unconstrained.
  - `MessageDelivery.ONCHAIN_UNCONSTRAINED`: Message stored on-chain but no guarantees on content - Use when sender is incentivized to deliver correctly but may not have off-chain channel to recipient
  - `MessageDelivery.OFFCHAIN`: Lowest cost, no on-chain data - Use when sender and recipient can communicate off-chain and sender is incentivized to deliver correctly

#### Accessing the Note

The `NoteMessage` type contains a `new_note` field that you can access if needed. Most commonly you'll call `.deliver()` on it:

#include_code constructor /docs/examples/contracts/counter_contract/src/main.nr rust

Methods that return `NoteMessage` include `initialize()`, `get_note()`, and `replace()` on `PrivateMutable`, `initialize()` on `PrivateImmutable`, and `insert()` on `PrivateSet`.

### Choosing a Private State Variable

Due to the complexities of Aztec's private state model, private state variables do not map 1:1 with public state variables. Understanding these differences between the different private state variables is important when it comes to designing private smart contracts.

Below is a table comparing certain key properties of the different private state variables Aztec.nr offers:

| State variable     | Mutable? | Cost to read? | Writable by third parties? | Example use case                                                                                               |
| ------------------ | -------- | ------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PrivateMutable`   | yes      | yes           | no                         | Mutable user state only accessible by them (e.g. user settings or keys)                                        |
| `PrivateImmutable` | no       | no            | no                         | Fixed configuration, one-way actions (e.g. initialization settings for a proposal)                             |
| `PrivateSet`       | yes      | yes           | yes                        | Aggregated state others can add to, e.g. token balance (set of amount notes), nft collections (set of nft ids) |

### Owned State Variables

Private state variables like `PrivateMutable`, `PrivateImmutable`, and `PrivateSet` implement the `OwnedStateVariable` trait. You must wrap them in `Owned`:

#include_code storage_struct /docs/examples/contracts/counter_contract/src/main.nr rust

Access the underlying state variable for a specific owner using `.at(owner)`:

#include_code increment /docs/examples/contracts/counter_contract/src/main.nr rust

### PrivateMutable

`PrivateMutable` is conceptually similar to `PublicMutable` and regular Solidity state variables in that it is a variable that has exactly one value at any point in time that can be read and written. However, for `PrivateMutable`:

- The value is, of course, _private_, meaning only the account the value belongs to can read it.
- _Only ONE account can read and write the state variable_. It is not possible for example to use a `PrivateMutable` to store user settings and then have some admin account alter these settings.
- Reading the current value results in the state variable being updated, increasing tx costs and requiring delivery of a note message.
- There is no `write` function - the current value is instead `replace`d.

For PrivateMutable examples, see the test_contract which demonstrates initialization, reading, and replacement patterns for private mutable state.

### PrivateImmutable

`PrivateImmutable` represents a unique private state variable that, as the name suggests, is immutable. Once initialized, its value cannot be altered. This is the private equivalent of `PublicImmutable`, except the value is only known to its owner.

Unlike a `PrivateMutable`, the `get_note` function for a `PrivateImmutable` doesn't nullify the current note and returns the `Note` directly (not wrapped in `NoteMessage`). This means that multiple accounts can concurrently call this function to read the value.

### PrivateSet

`PrivateSet` is used for managing a collection of notes. Like `PrivateMutable`, this is a private state variable that can be modified. There are two key differences:

- A `PrivateSet` is not a single value but a _set_ (a collection) of values (represented by notes)
- Any account can insert values into someone else's set.

The set's current value is the collection of notes in the set that have not yet been nullified. These notes can have any type: they could be nft IDs, representing a user's nft collection, or they might be token amounts, in which case _the sum_ of all values in the set would be the user's current balance.

#### Example Usage

Here's how a token contract uses PrivateSet for balances:

#include_code transfer_private /docs/examples/contracts/bob_token_contract/src/main.nr rust

And checking balances:

#include_code check_balances /docs/examples/contracts/bob_token_contract/src/main.nr rust

Note: The `Owned` wrapper requires calling `.at(owner)` to access the underlying `PrivateSet` for a specific owner. This binds the owner to the state variable instance.

### SinglePrivateMutable and SinglePrivateImmutable

For contract-wide private values (not per-owner), use `SinglePrivateMutable` or `SinglePrivateImmutable`. These store exactly one value for the entire contract - a global singleton - rather than separate values per owner.

| Type | Use Case | Access Pattern |
|------|----------|----------------|
| `Owned<PrivateMutable<...>>` | Per-owner private state (like balances) | `.at(owner).get_note()` |
| `SinglePrivateMutable` | Contract-wide singleton (like admin) | `.get_note()` directly |

Since there's only one value at the storage slot, there's no need to specify an owner to look it up:

```rust
#[storage]
struct Storage<Context> {
    admin: SinglePrivateMutable<AddressNote, Context>,
    config: SinglePrivateImmutable<ConfigNote, Context>,
}

// Access directly without .at(owner)
let note_message = self.storage.admin.get_note();
let config = self.storage.config.get_note();
```

When initializing, you still pass an owner address - but this specifies who can decrypt the note, not the storage location:

```rust
// owner_address determines who can see the note, not where it's stored
self.storage.admin.initialize(note, owner_address).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
```

:::warning

SinglePrivateMutable uses a nullify-and-recreate pattern when reading. Unless the caller is incentivized to deliver the note message correctly, you should use `MessageDelivery.ONCHAIN_CONSTRAINED` to prevent malicious actors from bricking the contract by failing to deliver the note.

:::

## Containers

### Map

A `Map` is a key-value container that maps keys to state variables - just like Solidity's `mapping`. It can be used with any state variable to create independent instances for each key.

For example, a `Map<AztecAddress, PublicMutable<u128>>` can be accessed with an address to obtain the `PublicMutable` that corresponds to it. This is exactly equivalent to a Solidity `mapping (address => uint)`.

#### Declaration and Usage

Here's an example from the BobToken contract:

#include_code storage /docs/examples/contracts/bob_token_contract/src/main.nr rust

Use the `.at()` method to access values by key:

#include_code transfer_public /docs/examples/contracts/bob_token_contract/src/main.nr rust

This is equivalent to Solidity's `public_balances[account]` pattern.

Maps can contain other maps for multi-dimensional lookups:

```rust
// Map game_id -> player_address -> score
games: Map<Field, Map<AztecAddress, PublicMutable<u32, Context>, Context>, Context>,

// Access: self.storage.games.at(game_id).at(player).read()
```

:::note

Maps can only be used with public state variables (`PublicMutable`, `PublicImmutable`, `DelayedPublicMutable`) or other `Map`s. For private state, use the `Owned` wrapper described above.

:::

### Owned

The `Owned` wrapper is used with private state variables (`PrivateMutable`, `PrivateImmutable`, and `PrivateSet`) to associate them with a specific owner. This is necessary because private state variables need to know which address owns the notes they manage.

The `Owned` wrapper is essential for private state variables because it binds the owner's address to the state variable instance, enabling proper note encryption, nullifier computation, and access control.

## Custom Structs in Public Storage

Both `PublicMutable` and `PublicImmutable` are generic over any serializable type, which means you can store custom structs in public storage.

### Define a Custom Struct

To use a custom struct in public storage, it must implement the `Packable` trait:

```rust
use dep::aztec::protocol_types::{
    address::AztecAddress,
    traits::{Deserialize, Packable, Serialize}
};

#[derive(Deserialize, Packable, Serialize)]
pub struct Asset {
    pub interest_accumulator: u128,
    pub last_updated_ts: u64,
    pub loan_to_value: u128,
    pub oracle: AztecAddress,
}
```

### Store and Use Custom Structs

```rust
#[storage]
struct Storage<Context> {
    assets: Map<Field, PublicMutable<Asset, Context>, Context>,
}

#[external("public")]
fn update_asset(asset_id: Field, new_accumulator: u128) {
    let mut asset = self.storage.assets.at(asset_id).read();
    asset.interest_accumulator = new_accumulator;
    self.storage.assets.at(asset_id).write(asset);
}
```

## Storage Slots

Each state variable gets assigned a different numerical value for their **storage slot**. How they are used depends on the kind of state variable:

- For public state variables, storage slots are related to slots in the public data tree
- For private state variables, storage slots are metadata that gets included in the note hash

The purpose of slots is the same for both domains: they keep the values of different state values _separate_ so that they do not interfere with one another.

Storage slots are a low-level detail that developers don't typically need to concern themselves with. They are automatically allocated to each state variable by Aztec.nr.
