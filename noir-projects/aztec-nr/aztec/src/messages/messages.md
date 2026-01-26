# Message Encoding and Encryption

This document describes how private messages are encoded, encrypted, and delivered in Aztec. Messages are used to communicate private information (such as note data or events) to recipients in a way that only they can decrypt.

---

## Developer Abstraction

Developers work with three high-level concepts, each mapped to a message type under the hood:

| Concept | Developer API | Message Type ID | Description |
|---------|---------------|-----------------|-------------|
| **Private Notes** | `storage.insert(note).deliver()` | `PRIVATE_NOTE_MSG_TYPE_ID = 0` | Notes created entirely in private, containing all information needed to prove existence |
| **Partial Notes** | `storage.insert(partial_note).deliver()` | `PARTIAL_NOTE_PRIVATE_MSG_TYPE_ID = 1` | Notes with both private and public fields; the private message contains info to find the public portion |
| **Private Events** | `self.emit(event).deliver_to(recipient, mode)` | `PRIVATE_EVENT_MSG_TYPE_ID = 2` | Events emitted privately, encrypted for a specific recipient |

### Delivery Modes

All message delivery accepts a `MessageDelivery` mode that controls cost and trust guarantees:

| Mode | Usage | Cost | Guarantees |
|------|-------|------|------------|
| `OFFCHAIN` | Sender delivers directly to recipient | None | None - sender controls delivery |
| `ONCHAIN_UNCONSTRAINED` | Message stored on-chain, encryption not proven | DA fees | Availability only |
| `ONCHAIN_CONSTRAINED` | Message stored on-chain, encryption proven in circuit | DA fees + proving | Full - correct encryption verified |

**When to use each:**
- `OFFCHAIN` - Sender is incentivized to deliver (e.g., self-transfers, recipient waits for acknowledgment)
- `ONCHAIN_UNCONSTRAINED` - Sender motivated but no off-chain channel exists
- `ONCHAIN_CONSTRAINED` - Sender cannot be trusted (e.g., authorized transfers where caller ≠ owner)

From the developer's perspective, the framework handles all encoding, encryption, and delivery automatically based on the chosen mode.

---

## Implementation Overview

A message goes through several layers before being emitted on-chain:

```
Application Data
       │
       ▼
┌─────────────────┐
│  encode_message │  Encode into MESSAGE_PLAINTEXT (14 fields)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AES128 encrypt │  Encrypt into MESSAGE_CIPHERTEXT (17 fields)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ prefix_with_tag │  Add discovery tag (18 fields total)
└────────┬────────┘
         │
         ▼
    PRIVATE_LOG (on-chain)
```

## Layer 1: Private Log (On-Chain)

The outermost structure is the private log as stored on-chain.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      PRIVATE LOG (18 fields total)                       │
├─────────┬───────────────────────────────────────────────────────────────┤
│  Field  │                MESSAGE_CIPHERTEXT (17 fields)                 │
│    0    │                     (encrypted message)                       │
│  [TAG]  │                                                               │
└─────────┴───────────────────────────────────────────────────────────────┘
     │
     └── Derived from sender/recipient shared secret.
         Used by recipient to efficiently find their messages.
         See: logs/utils.nr :: prefix_with_tag()
```

**Constants:**
- `PRIVATE_LOG_SIZE_IN_FIELDS = 18`
- `PRIVATE_LOG_CIPHERTEXT_LEN = 17` (18 - 1 for tag)

## Layer 2: Message Ciphertext (17 fields)

The encrypted message structure, before the tag is prepended.

```
┌──────────────────┬──────────────────────────────────────────────────────┐
│      Field 0     │           Fields 1-16 (bytes packed into fields)     │
│    EPH_PK_X      │              MESSAGE_BYTES_AS_FIELDS                 │
│  (1 full Field)  │      (bytes_to_fields: 31 bytes per field)           │
└──────────────────┴──────────────────────────────────────────────────────┘
         │                                   │
         │                                   └── See Layer 3
         │
         └── x-coordinate of ephemeral public key.
             Combined with recipient's private key to derive
             the shared secret used for AES key derivation.
             See: encryption/aes128.nr :: encrypt()
```

**Constants:**
- `MESSAGE_CIPHERTEXT_LEN = 17`
- `EPH_PK_X_SIZE_IN_FIELDS = 1`

## Layer 3: Message Bytes (inside Fields 1-16)

The byte-level structure within the encrypted portion.

```
Total: 16 fields × 31 bytes = 496 bytes

┌───────┬─────────────────────┬─────────────────────────────────┬─────────┐
│ Byte  │    Bytes 1-16       │        Bytes 17-496             │Remaining│
│   0   │  HEADER_CIPHERTEXT  │     BODY_CIPHERTEXT             │ PADDING │
│ SIGN  │   (16 bytes)        │   (variable, AES encrypted)     │ (random)│
│ BYTE  │                     │                                 │         │
└───────┴─────────────────────┴─────────────────────────────────┴─────────┘
   │              │                         │                        │
   │              │                         │                        │
   │              │                         │                        └── Random bytes to pad
   │              │                         │                            to fixed size (privacy)
   │              │                         │
   │              │                         └── AES128 encrypted MESSAGE_PLAINTEXT
   │              │                             Encrypted with body_sym_key/body_iv
   │              │
   │              └── AES128 encrypted header containing body length:
   │                  ┌───────────────────────────────────────┐
   │                  │  Plaintext (2 bytes):                 │
   │                  │  ┌─────────┬─────────┐                │
   │                  │  │ len[hi] │ len[lo] │ + PKCS#7 pad   │
   │                  │  │ 1 byte  │ 1 byte  │   (14 bytes)   │
   │                  │  └─────────┴─────────┘                │
   │                  │  Encrypted with header_sym_key/iv     │
   │                  └───────────────────────────────────────┘
   │
   └── Sign bit of ephemeral public key's y-coordinate (0 or 1).
       Combined with EPH_PK_X to reconstruct the full point.
```

**Constants:**
- `HEADER_CIPHERTEXT_SIZE_IN_BYTES = 16`
- `EPH_PK_SIGN_BYTE_SIZE_IN_BYTES = 1`

## Layer 4: Message Plaintext (Decrypted Body)

The plaintext message structure after decryption.

```
Max: 14 fields (MESSAGE_PLAINTEXT_LEN)
     = 479 bytes / 32 bytes per serialized Field

┌─────────────────────────────────────┬───────────────────────────────────┐
│             Field 0                 │       Fields 1-13                 │
│      EXPANDED_METADATA              │        MSG_CONTENT                │
│        (1 Field, 128 bits)          │ (up to MAX_MESSAGE_CONTENT_LEN=13)│
└─────────────────────────────────────┴───────────────────────────────────┘
                 │                                     │
                 │                                     └── Application-specific data
                 │                                         (note fields, event data, etc.)
                 │
                 └── See Layer 5
```

**Constants:**
- `MESSAGE_PLAINTEXT_LEN = 14`
- `MESSAGE_EXPANDED_METADATA_LEN = 1`
- `MAX_MESSAGE_CONTENT_LEN = 13`

**Size derivation:**
```
MESSAGE_PLAINTEXT_SIZE_IN_BYTES = (17 - 1) * 31 - 16 - 1 = 479 bytes
MESSAGE_PLAINTEXT_LEN = 479 / 32 = 14 fields
```

## Layer 5: Expanded Metadata (128 bits)

The first field of the plaintext, containing message type and metadata.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     EXPANDED_METADATA (1 Field, 128 bits used)          │
├─────────────────────────────────────┬───────────────────────────────────┤
│            Upper 64 bits            │          Lower 64 bits            │
│           MSG_TYPE_ID (u64)         │         MSG_METADATA (u64)        │
├─────────────────────────────────────┼───────────────────────────────────┤
│  0 = PRIVATE_NOTE_MSG_TYPE_ID       │  Meaning depends on MSG_TYPE_ID   │
│  1 = PARTIAL_NOTE_PRIVATE_MSG_TYPE  │  (application-specific metadata)  │
│  2 = PRIVATE_EVENT_MSG_TYPE_ID      │                                   │
└─────────────────────────────────────┴───────────────────────────────────┘
```

**Encoding formula:**
```
expanded_metadata = (msg_type_id as Field) * 2^64 + (msg_metadata as Field)
```

See: `encoding.nr :: to_expanded_metadata()` and `msg_type.nr`

## Size Summary

```
PRIVATE_LOG_SIZE_IN_FIELDS = 18
  ├── TAG: 1 field
  └── MESSAGE_CIPHERTEXT_LEN = 17 fields
        ├── EPH_PK_X: 1 field
        └── Encrypted bytes: 16 fields × 31 bytes = 496 bytes
              ├── Sign byte: 1 byte
              ├── Header ciphertext: 16 bytes
              └── Body ciphertext + padding: 479 bytes
                    └── MESSAGE_PLAINTEXT: 479 bytes ÷ 32 = 14 fields
                          ├── Expanded metadata: 1 field
                          └── MAX_MESSAGE_CONTENT: 13 fields
```

## Encryption Flow

```
                         SENDER SIDE
                             │
         ┌───────────────────┼───────────────────┐
         │                   ▼                   │
         │   [msg_type, msg_metadata, content]   │
         │                   │                   │
         │          encode_message()             │
         │          (encoding.nr)                │
         │                   │                   │
         │                   ▼                   │
         │      MESSAGE_PLAINTEXT (14 fields)    │
         │                   │                   │
         │          fields_to_bytes()            │
         │                   │                   │
         │                   ▼                   │
         │       Plaintext bytes (≤448 bytes)    │
         │                   │                   │
         │   AES128 encrypt with body_key/iv     │
         │   AES128 encrypt header with          │
         │        header_key/iv                  │
         │          (encryption/aes128.nr)       │
         │                   │                   │
         │                   ▼                   │
         │   Prepend sign byte, append padding   │
         │                   │                   │
         │          bytes_to_fields()            │
         │                   │                   │
         │                   ▼                   │
         │       Prepend EPH_PK_X                │
         │                   │                   │
         │                   ▼                   │
         │   MESSAGE_CIPHERTEXT (17 fields)      │
         │                   │                   │
         │          prefix_with_tag()            │
         │          (logs/utils.nr)              │
         │                   │                   │
         │                   ▼                   │
         │       PRIVATE_LOG (18 fields)         │
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
                         ON-CHAIN
```

## Decryption Flow

```
                        RECIPIENT SIDE
                             │
         ┌───────────────────┼───────────────────┐
         │                   ▼                   │
         │       PRIVATE_LOG (18 fields)         │
         │                   │                   │
         │           Strip tag                   │
         │                   │                   │
         │                   ▼                   │
         │   MESSAGE_CIPHERTEXT (17 fields)      │
         │                   │                   │
         │      Extract EPH_PK_X (field 0)       │
         │      Extract sign byte                │
         │      Reconstruct ephemeral pubkey     │
         │                   │                   │
         │      Derive shared secret using       │
         │      recipient's private key          │
         │                   │                   │
         │      Derive AES keys from secret      │
         │          (encryption/aes128.nr)       │
         │                   │                   │
         │                   ▼                   │
         │      Decrypt header → get body len    │
         │      Decrypt body ciphertext          │
         │                   │                   │
         │          fields_from_bytes()          │
         │                   │                   │
         │                   ▼                   │
         │      MESSAGE_PLAINTEXT (14 fields)    │
         │                   │                   │
         │          decode_message()             │
         │          (encoding.nr)                │
         │                   │                   │
         │                   ▼                   │
         │   [msg_type, msg_metadata, content]   │
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
                      APPLICATION DATA
```

## Key Derivation

Both the header and body use separate AES keys derived from the same ECDH shared secret:

```
shared_secret = ECDH(eph_sk, recipient_address_point)
             or ECDH(recipient_address_sk, eph_pk)

[random_256_bits_0, random_256_bits_1] = poseidon2_kdf(shared_secret)

body_sym_key   = random_256_bits_0[0:16]
body_iv        = random_256_bits_0[16:32]

header_sym_key = random_256_bits_1[0:16]
header_iv      = random_256_bits_1[16:32]
```

See: `encryption/aes128.nr :: derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe()`

## Privacy Considerations

1. **Fixed-size logs**: All private logs are padded to exactly 18 fields with random data, preventing message length from leaking information.

2. **Random padding**: Unused bytes in the ciphertext are filled with random values, not zeros.

3. **Ephemeral keys**: Each message uses a fresh ephemeral key pair, ensuring no key reuse.

4. **Tagging**: Tags are derived from sender/recipient shared secrets, allowing recipients to find their messages without revealing the relationship to others.

## Related Files

- `encoding.nr` - Message plaintext encoding/decoding
- `msg_type.nr` - Message type ID constants
- `encryption/aes128.nr` - AES128 encryption implementation
- `encryption/message_encryption.nr` - Encryption trait
- `logs/utils.nr` - Tag prefixing
- `message_delivery.nr` - Delivery mode orchestration

---

# Developer Usage Guide

This section describes how developers can use the message framework abstractions in their contracts.

## Message Delivery Modes

The framework provides three delivery modes via `MessageDelivery`:

```noir
use aztec::messages::message_delivery::MessageDelivery;
```

| Mode                    | Cost                             | Guarantees                                      | Use When                                         |
| ----------------------- | -------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `OFFCHAIN`              | Zero fees, zero proving overhead | None - sender controls delivery                 | Sender is incentivized to deliver correctly      |
| `ONCHAIN_UNCONSTRAINED` | DA fees only                     | Message stored on-chain, but content unverified | Sender motivated but no off-chain channel exists |
| `ONCHAIN_CONSTRAINED`   | DA fees + proving overhead       | Full guarantees - correct encryption verified   | Sender cannot be trusted to deliver correctly    |

## Working with Notes

Notes are the primary way to store private state. When creating or modifying notes, you must deliver the note message to the owner so they can discover and spend the note.

### Basic Note Operations

All note operations return a message that must be delivered:

```noir
// Adding to a balance (e.g., receiving tokens)
self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

// Subtracting from a balance (e.g., spending tokens)
self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

// Inserting a note into a set
self.storage.notes.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

// Initializing a SinglePrivateMutable
self.storage.admin.initialize(AddressNote { address: admin }, admin)
    .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

// Replacing a note in SinglePrivateMutable
self.storage.total_supply
    .replace(|current| UintNote { value: current.value + amount }, owner)
    .deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);
```

### Delivering to a Specific Recipient

For notes where the owner differs from the natural recipient, use `deliver_to`:

```noir
// Deliver note message to a specific recipient (not the note owner)
self.storage.balances.at(owner).insert(note).deliver_to(
    recipient,
    MessageDelivery.OFFCHAIN,
);
```

### Token Transfer Example (from `token_contract`)

```noir
#[external("private")]
fn transfer(to: AztecAddress, amount: u128) {
    let from = self.msg_sender().unwrap();

    // Subtract from sender - use UNCONSTRAINED since sender is motivated to deliver their own change
    let change = self.internal.subtract_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
    self.storage.balances.at(from).add(change).deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);

    // Add to recipient - also UNCONSTRAINED since payment considered complete when recipient decrypts
    self.storage.balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);

    // Emit transfer event to recipient
    self.emit(Transfer { from, to, amount }).deliver_to(to, MessageDelivery.ONCHAIN_UNCONSTRAINED);
}
```

### Authorized Transfer Example (from `token_contract`)

When transferring on behalf of another user (with authwit), use CONSTRAINED delivery since the caller may not be the note owner:

```noir
#[authorize_once("from", "authwit_nonce")]
#[external("private")]
fn transfer_in_private(
    from: AztecAddress,
    to: AztecAddress,
    amount: u128,
    authwit_nonce: Field,
) {
    // Use CONSTRAINED - caller may not be `from`, so can't trust them to deliver
    self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    self.storage.balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

## Working with Events

Events communicate information to recipients without creating spendable notes. Declare events with the `#[event]` macro:

```noir
#[event]
struct Transfer {
    from: AztecAddress,
    to: AztecAddress,
    amount: u128,
}
```

### Emitting Private Events

Private events are encrypted and delivered to specific recipients:

```noir
// Emit to msg_sender
self.emit(TestEvent { value }).deliver_to(
    self.msg_sender().unwrap(),
    MessageDelivery.ONCHAIN_UNCONSTRAINED
);

// Emit to a specific recipient
self.emit(Transfer { from, to, amount }).deliver_to(
    to,
    MessageDelivery.ONCHAIN_CONSTRAINED
);

// Emit the same event to multiple recipients
let event = ExampleEvent0 { value0, value1 };
self.emit(event).deliver_to(self.msg_sender().unwrap(), MessageDelivery.ONCHAIN_CONSTRAINED);
self.emit(event).deliver_to(other, MessageDelivery.ONCHAIN_CONSTRAINED);
```

### Emitting Public (Unencrypted) Events

In public functions, events are emitted unencrypted:

```noir
#[external("public")]
fn emit_unencrypted_events(preimages: [Field; 4]) {
    // No delivery mode needed - public events are unencrypted
    self.emit(ExampleEvent0 { value0: preimages[0], value1: preimages[1] });
}
```

## Off-chain Message Delivery

For maximum efficiency when sender and recipient can communicate directly:

```noir
// Event delivered off-chain
self.emit(TestEvent { a, b, c }).deliver_to(
    self.msg_sender().unwrap(),
    MessageDelivery.OFFCHAIN,
);

// Note delivered off-chain
self.storage.balances.at(owner).insert(note).deliver_to(
    self.msg_sender().unwrap(),
    MessageDelivery.OFFCHAIN,
);
```

**When to use OFFCHAIN:**
- Payment apps where recipient waits for note before acknowledging
- Self-transfers (change notes)
- Game state updates sent to a server
- Any scenario where sender is incentivized to deliver correctly

**When NOT to use OFFCHAIN:**
- Smart contract escrow scenarios
- Cases where a malicious sender could benefit from withholding the message
- When the recipient has no way to verify delivery happened

## Choosing the Right Delivery Mode

### Decision Flow

```
Is sender incentivized to deliver correctly?
├── NO → Use ONCHAIN_CONSTRAINED
└── YES
    ├── Is there an off-chain channel? → Use OFFCHAIN
    └── No off-chain channel → Use ONCHAIN_UNCONSTRAINED
```

### Common Patterns

| Scenario                              | Recommended Mode                      | Rationale                                           |
| ------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| Self-transfer (change note)           | `OFFCHAIN` or `ONCHAIN_UNCONSTRAINED` | Sender only harms themselves by not delivering      |
| Payment to another user               | `ONCHAIN_UNCONSTRAINED`               | Recipient won't acknowledge until they receive note |
| Authorized transfer (`from` ≠ caller) | `ONCHAIN_CONSTRAINED`                 | Caller may not deliver to `from`                    |
| Fee payment to protocol               | `ONCHAIN_CONSTRAINED`                 | Payer has no incentive to deliver to protocol       |
| Escrow deposit                        | `ONCHAIN_CONSTRAINED`                 | Contract needs guaranteed delivery                  |
| Mint to admin (admin is caller)       | `ONCHAIN_UNCONSTRAINED`               | Admin motivated to receive their own tokens         |
| Mint to third party                   | `ONCHAIN_CONSTRAINED`                 | Minter may not deliver to recipient                 |

## Complete Contract Examples

### Simple Token with Mixed Delivery (from `private_token_contract`)

```noir
#[external("private")]
#[initializer]
fn constructor(initial_admin_balance: u128, admin: AztecAddress) {
    // CONSTRAINED - deployer may not be admin
    self.storage.admin.initialize(AddressNote { address: admin }, admin)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

    // CONSTRAINED - deployer may not be admin
    self.storage.balances.at(admin).add(initial_admin_balance)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

    self.storage.total_supply
        .initialize(UintNote { value: initial_admin_balance }, admin)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}

#[external("private")]
fn mint(amount: u128, recipient: AztecAddress) {
    let replacement_note_message = self.storage.admin.get_note();
    let admin = replacement_note_message.get_note().address;
    assert(admin == self.msg_sender().unwrap(), "Only admin can mint");

    // UNCONSTRAINED - admin delivers to themselves
    replacement_note_message.deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);

    // UNCONSTRAINED - admin is owner of total_supply note
    self.storage.total_supply
        .replace(|current| UintNote { value: current.value + amount }, admin)
        .deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);

    // CONSTRAINED - recipient may differ from admin
    self.storage.balances.at(recipient).add(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

### Event-Only Contract (from `event_only_contract`)

```noir
#[event]
struct TestEvent {
    value: Field,
}

#[external("private")]
fn emit_event_for_msg_sender(value: Field) {
    let sender = self.msg_sender().unwrap();
    // UNCONSTRAINED - sender delivers to themselves
    self.emit(TestEvent { value }).deliver_to(sender, MessageDelivery.ONCHAIN_UNCONSTRAINED);
}
```

### Escrow Pattern (from `escrow_contract`)

```noir
#[external("private")]
#[initializer]
fn constructor(owner: AztecAddress) {
    let note = AddressNote { address: owner };
    // CONSTRAINED - deployer may not be owner
    self.storage.owner.initialize(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

## Advanced: Manual Message Construction

For custom message types, you can use the lower-level encoding functions:

```noir
use aztec::messages::encoding::{encode_message, decode_message, MAX_MESSAGE_CONTENT_LEN};
use aztec::messages::msg_type::PRIVATE_NOTE_MSG_TYPE_ID;

// Encode a custom message
let msg_content = [field1, field2, field3];
let plaintext = encode_message(PRIVATE_NOTE_MSG_TYPE_ID, metadata, msg_content);

// Decode a message
let (msg_type_id, msg_metadata, msg_content) = decode_message(plaintext_bounded_vec);
```

## Size Constraints

When designing custom notes or events, be aware of size limits:

| Type                         | Max Packed Length                         | Notes                                 |
| ---------------------------- | ----------------------------------------- | ------------------------------------- |
| Note content                 | `MAX_NOTE_PACKED_LEN = 10`                | After owner, storage_slot, randomness |
| Event content                | `MAX_EVENT_SERIALIZED_LEN = 12`           | After randomness                      |
| Partial note private content | `MAX_PARTIAL_NOTE_PRIVATE_PACKED_LEN = 9` | After owner, slot, randomness, tag    |

These limits derive from `MAX_MESSAGE_CONTENT_LEN = 13` fields minus reserved fields for each message type.
