---
title: Note Delivery
tags: [storage, concepts, notes]
description: Learn how to deliver notes to recipients in Aztec smart contracts using different delivery modes to balance proving time, transaction costs, and delivery guarantees.
sidebar_position: 4
---

When you create a note in an Aztec smart contract, you must deliver it to the recipient so they can use it. This guide explains how note delivery works and how to choose the right delivery mode for your use case.

## Overview

In Aztec, creating a note involves two steps:
1. **Creating the note** - Adding the note hash to the note hash tree
2. **Delivering the note** - Sending the note contents to the recipient so they can decrypt and use it

Without delivery, the recipient won't know the note exists or be able to access its contents, even though the note hash is on-chain.

## The `.deliver()` Method

When you create a note using state variables like `PrivateSet`, `BalanceSet`, or `SinglePrivateMutable`, the creation methods return a `NoteMessage` or `MaybeNoteMessage` object. You must call `.deliver()` on this object to send the note to the recipient.

```rust
#[aztec]
pub contract PrivateToken {
    use aztec::messages::message_delivery::MessageDelivery;

    #[external("private")]
    fn mint(amount: u128, recipient: AztecAddress) {
        // Adding to the balance returns a MaybeNoteMessage
        self.storage.balances.at(recipient).add(amount)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }
}
```

## Delivery Modes

Aztec provides three delivery modes that offer different tradeoffs between cost, proving time, and guarantees:

### `MessageDelivery.OFFCHAIN`

**Fully off-chain delivery with no guarantees.**

- **Use when:** The sender is incentivized to deliver correctly (e.g., sending to yourself, payment for goods/services where recipient must receive the note to complete the transaction)
- **Costs:** Zero transaction fees, zero proving time overhead
- **Guarantees:** None - sender can fail to deliver or deliver incorrect content
- **Privacy:** Maximum - no on-chain data emitted

**Example use cases:**
- Change notes when transferring tokens (you're sending to yourself)
- Payments where the recipient won't provide goods/services without the note
- Messages to local accounts controlled by the sender
- Game state updates to a server that requires them

```rust
// Change note - sender is motivated to deliver to themselves
self.storage.balances.at(sender).add(change_amount)
    .deliver(MessageDelivery.OFFCHAIN);
```

### `MessageDelivery.ONCHAIN_UNCONSTRAINED`

**On-chain delivery with no content guarantees.**

- **Use when:** You need on-chain backup/discoverability but the sender is still incentivized to deliver correctly
- **Costs:** DA gas fees for the encrypted log, zero proving time overhead
- **Guarantees:** Message stored on-chain and retrievable, but sender can deliver incorrect content or wrong tag
- **Privacy:** High - encrypted log reveals minimal information

**Example use cases:**
- Escrow deposits where recipient won't proceed without receiving the note
- Scenarios where sender cannot contact recipient off-chain
- When you want automatic backup without off-chain responsibility

```rust
// Minting to an admin who controls the contract
self.storage.balances.at(admin).add(amount)
    .deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);
```

### `MessageDelivery.ONCHAIN_CONSTRAINED`

**On-chain delivery with guaranteed correct content.**

  **WARNING**: This mode is [currently NOT fully constrained](https://github.com/AztecProtocol/aztec-packages/issues/14565). The log's tag is unconstrained, meaning a malicious sender could prevent the recipient from finding the message.

- **Use when:** The sender cannot be trusted to deliver correctly (e.g., paying fees, creating notes for others, multisig configuration changes)
- **Costs:** DA gas fees for encrypted log + nullifiers, proving time overhead for encryption and tagging
- **Guarantees:** Recipient receives correctly encrypted content (once tag constraining is implemented, recipient will be able to find it)
- **Privacy:** Moderate - encrypted logs and nullifiers create on-chain fingerprints

**Example use cases:**
- Protocol fee payments (sender has no incentive to deliver correctly)
- Minting tokens to arbitrary recipients
- Admin transfers where new admin is not the sender
- Multisig or DAO configuration updates

```rust
// Minting to an arbitrary recipient - must guarantee delivery
self.storage.balances.at(recipient).add(amount)
    .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
```

## Choosing a Delivery Mode

Ask yourself: **"Is the sender incentivized to deliver this note correctly?"**

- **Yes, and they can contact the recipient off-chain** ’ Use `OFFCHAIN`
- **Yes, but they cannot or prefer not to contact them off-chain** ’ Use `ONCHAIN_UNCONSTRAINED`
- **No, the sender might not deliver correctly** ’ Use `ONCHAIN_CONSTRAINED`

## Note Discovery and the Sender

The "sender" in note delivery is **not** the transaction sender - it's the **sender for tags**, which is typically the account contract that initiated the transaction.

Account contracts call `set_sender_for_tags(account_address)` before making calls to other contracts. This address is used to compute the tag that allows recipients to discover notes.

### Discovering Notes from Unknown Senders

**You cannot receive notes from an unknown sender** without additional mechanisms. The current tagging system requires both sender and recipient addresses to compute the shared secret used for tag generation.

There are three broad families of solutions to this problem:

**a) Brute force search** - Scan every log and test if it decrypts. This has obvious performance issues as the network grows.

**b) Tagging with known sender** (current implementation) - You know who will send you messages and search for those specifically. Very fast, but requires knowing the sender in advance. If a sender begins spamming you, you can remove them from your search.

**c) Tagging with handshaking** - An intermediate solution where you can be notified of new senders. A handshake occurs on-chain that lets the recipient discover a new sender, and from that point on regular tagging works. This either:
- Is fast but leaks privacy (e.g., a public event saying "new handshake for Alice!")
- Is slow but private (you brute force scan handshake logs to find ones meant for you)

**Handshaking is a possibility in the design space but hasn't been implemented in Aztec.nr yet.** The design space for handshaking solutions is large, with various tradeoffs involving infrastructure requirements, privacy, and performance.

For now, if you need to receive notes from unknown senders, you must implement a custom discovery mechanism, such as:
- Having senders register themselves in a contract first
- Using off-chain communication to share sender addresses
- Setting up an intermediary service to handle discovery

See the [Note Discovery](../foundational-topics/advanced/storage/note_discovery.md) documentation for more details on the tagging mechanism and its limitations.

## Delivering to Someone Other Than the Note Owner

You can deliver a note to an address other than the note's owner using `.deliver_to()`:

```rust
// Create a note owned by `owner` but deliver it to `auditor`
self.storage.balances.at(owner).add(amount)
    .deliver_to(auditor, MessageDelivery.ONCHAIN_CONSTRAINED);
```

**Important:** The recipient (`auditor`) can see the note was created but **cannot use it** - only the owner can nullify and spend the note. The recipient also cannot see when/if the note is nullified.

**Use cases:**
- Compliance/auditing requirements where third parties need visibility
- Game servers that track all note creation
- Analytics or monitoring services

## Code Examples

### Private Token Transfer

```rust
#[external("private")]
fn transfer(amount: u128, sender: AztecAddress, recipient: AztecAddress) {
    // Subtract from sender - constrained delivery ensures recipient gets their note
    self.storage.balances.at(sender)
        .sub(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

    // Add to recipient - constrained delivery for untrusted sender
    self.storage.balances.at(recipient)
        .add(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

### Admin Initialization

```rust
#[external("private")]
#[initializer]
fn constructor(admin: AztecAddress) {
    // Admin is the owner of the note and is motivated to receive it
    // Use unconstrained delivery since we don't know if deployer is incentivized
    self.storage.admin
        .initialize(AddressNote { address: admin }, admin)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

### Self-Transfer with Change

```rust
#[external("private")]
fn transfer_with_change(amount: u128, from: AztecAddress, to: AztecAddress) {
    let subtracted = self.storage.balances.at(from).try_sub(amount, 10);
    let change = subtracted - amount;

    // Change goes back to sender - use offchain delivery
    self.storage.balances.at(from)
        .add(change)
        .deliver(MessageDelivery.OFFCHAIN);

    // Amount goes to recipient - use constrained delivery
    self.storage.balances.at(to)
        .add(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

## Related Documentation

- [Note Discovery](../foundational-topics/advanced/storage/note_discovery.md) - How recipients find notes using tags
- [State Management](../foundational-topics/state_management.md) - Overview of state variables that create notes
