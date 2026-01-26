# Messages Module Security Review

**Review Date:** 2026-01-24
**Reviewer:** Claude (Automated Security Analysis)
**Scope:** `aztec/src/messages/` module

---

## Executive Summary

The messages module handles private message encoding, encryption, and delivery. All content types (private notes, partial notes, private events) currently use **AES-128 exclusively** with no mechanism for users to select alternative encryption schemes. The Poseidon2 encryption implementation exists but is not integrated into the message delivery pipeline.

---

## 1. Architecture Overview

### 1.1 Content Types and Message Flow

All message types follow the same encryption path:

```
Content (note/event)
    → encode_*_message()      [logs/note.nr, logs/event.nr, logs/partial_note.nr]
    → AES128::encrypt()       [encryption/aes128.nr]
    → prefix_with_tag()       [logs/utils.nr]
    → PRIVATE_LOG (on-chain) or offchain delivery
```

Message types are distinguished by `msg_type_id` **inside the encrypted payload** (`msg_type.nr`):
- `PRIVATE_NOTE_MSG_TYPE_ID = 0`
- `PARTIAL_NOTE_PRIVATE_MSG_TYPE_ID = 1`
- `PRIVATE_EVENT_MSG_TYPE_ID = 2`

### 1.2 How Users Indicate Content Type

Users do **not** explicitly choose message types. The type is determined by which high-level API they use:

| API | Message Type | Encryption |
|-----|--------------|------------|
| Note creation macros | `PRIVATE_NOTE_MSG_TYPE_ID` | AES-128 (hardcoded) |
| `encode_partial_note_private_message()` | `PARTIAL_NOTE_PRIVATE_MSG_TYPE_ID` | AES-128 (hardcoded) |
| `encode_private_event_message()` | `PRIVATE_EVENT_MSG_TYPE_ID` | AES-128 (hardcoded) |

### 1.3 Delivery Mode Selection

Users **can** select delivery mode via `MessageDeliveryEnum` (`message_delivery.nr:25-175`):

| Mode | Medium | Encryption Constraints | Use Case |
|------|--------|----------------------|----------|
| `OFFCHAIN` | Off-chain | None (unconstrained) | Sender/recipient can communicate directly |
| `ONCHAIN_UNCONSTRAINED` | On-chain log | None (unconstrained) | No off-chain channel, sender trusted |
| `ONCHAIN_CONSTRAINED` | On-chain log | Fully constrained | Sender not trusted |

**Note:** `ONCHAIN_CONSTRAINED` tagging is currently NOT fully constrained (see `message_delivery.nr:127-129` and issue #14565).

### 1.4 Encryption Scheme Selection

**Users cannot select encryption scheme.** The encryption is hardcoded:

- `message_delivery.nr:212`: `AES128::encrypt(encode_into_message_plaintext(), recipient)`
- `partial_note.nr:48`: `AES128::encrypt(message_plaintext, recipient)`
- `process_message.nr:34`: `AES128::decrypt(message_ciphertext, message_context.recipient)`

---

## 2. Security Findings

### 2.1 HIGH: No Message Authentication for AES-128

**Location:** `encryption/aes128.nr`

**Issue:** AES-128 encryption provides confidentiality but NOT integrity/authenticity. Unlike the Poseidon2 implementation (`encryption/poseidon2.nr:122-137`) which includes a MAC check, AES decryption can return garbage data without detecting tampering.

**Current behavior:**
```noir
// aes128.nr:361 - decrypt returns Option based on curve point validity only
point_from_x_coord_and_sign(eph_pk_x, eph_pk_sign_bool).map(|eph_pk| {
    // ... decryption proceeds without MAC verification
})
```

**Comparison with Poseidon2:**
```noir
// poseidon2.nr:133-137 - has MAC verification
if c[L_UPPER_BOUND] != s[1] {
    decryption_failed = true;  // MAC check
}
```

**Impact:** A malicious actor who can modify ciphertexts could cause recipients to process corrupted data. The structural validation after decryption (e.g., checking `msg_type_id`) provides some defense-in-depth, but is not a cryptographic guarantee.

**Recommendation:** Consider implementing AES-GCM or adding HMAC to the AES-128 encryption scheme.

---

### 2.2 MEDIUM: Poseidon2 Encryption Not Integrated

**Location:** `encryption/poseidon2.nr` vs `encryption/message_encryption.nr`

**Issue:** The `MessageEncryption` trait exists (`message_encryption.nr:18-48`) but only `AES128` implements it. Poseidon2 encryption exists as standalone functions with:
- Different function signatures (takes `encryption_nonce` for replay protection)
- Built-in MAC
- Lower proving cost (~160 constraints for 8 fields)
- Different security tradeoffs (newer, less battle-tested, no post-quantum privacy)

**Current state:**
```noir
// message_encryption.nr - trait definition
pub trait MessageEncryption {
    fn encrypt<let PlaintextLen: u32>(...) -> [Field; MESSAGE_CIPHERTEXT_LEN];
    unconstrained fn decrypt(...) -> Option<BoundedVec<Field, MESSAGE_PLAINTEXT_LEN>>;
}

// Only AES128 implements this trait
impl MessageEncryption for AES128 { ... }

// Poseidon2 is standalone, NOT integrated
pub fn poseidon2_encrypt<let L: u32>(...) -> [Field; ((L + 2) / 3) * 3 + 1]
```

**Impact:** Users cannot choose the encryption scheme best suited to their security/performance requirements.

**Recommendation:** Either:
1. Integrate Poseidon2 into `MessageEncryption` trait with a scheme selection mechanism, OR
2. Document clearly that AES-128 is the only supported scheme and remove/deprecate Poseidon2, OR
3. Add ciphertext format versioning to allow future scheme additions

---

### 2.3 MEDIUM: No Replay Protection for AES

**Location:** `encryption/aes128.nr`

**Issue:** Poseidon2 has an `encryption_nonce` parameter documented for replay protection (`poseidon2.nr:27`), but AES has none.

**Current state:**
```noir
// poseidon2.nr:27-28
/// @param encryption_nonce is only needed if your use case needs to protect against replay attacks.
pub fn poseidon2_encrypt<let L: u32>(msg, shared_secret, encryption_nonce)

// aes128.nr - no nonce parameter
fn encrypt<let PlaintextLen: u32>(plaintext, recipient) -> [Field; MESSAGE_CIPHERTEXT_LEN]
```

**Mitigation:** The use of fresh ephemeral keys per message (`aes128.nr:172`) provides implicit replay resistance since each message has a unique shared secret. However, this is not explicitly documented.

**Recommendation:** Document the replay protection model for AES-128, or add explicit nonce support.

---

### 2.4 MEDIUM: Hardcoded AES-Specific Constants

**Location:** `encoding.nr:1-2`, `encoding.nr:13-30`

**Issue:** Multiple constants assume AES-128 is used:

```noir
// encoding.nr:1-2
// TODO(#12750): don't make these values assume we're using AES.

// encoding.nr:13-16 - AES-specific values
pub(crate) global HEADER_CIPHERTEXT_SIZE_IN_BYTES: u32 = 16;  // AES block size
pub global EPH_PK_X_SIZE_IN_FIELDS: u32 = 1;
pub global EPH_PK_SIGN_BYTE_SIZE_IN_BYTES: u32 = 1;
```

**Impact:** Adding alternative encryption schemes would require significant refactoring.

---

### 2.5 LOW: No Ciphertext Format Versioning

**Location:** Message encoding structure (`docs/messages.md`)

**Issue:** The `msg_type_id` identifies content type but is **inside** the encrypted payload. There is no unencrypted version byte or scheme identifier to indicate:
- Which encryption scheme was used
- Which message format version is in use

**Impact:** If the encryption scheme changes, recipients have no way to identify which decryption method to use without attempting multiple schemes.

**Recommendation:** Consider adding an unencrypted prefix byte indicating encryption scheme/version before the ephemeral public key.

---

### 2.6 LOW: Key Derivation Tied to AES

**Location:** `encryption/aes128.nr:147-155`

**Issue:** The KDF produces 16-byte key + 16-byte IV pairs specifically for AES:

```noir
pub fn derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe<let N: u32>(
    shared_secret: Point,
) -> [([u8; 16], [u8; 16]); N]
```

**Impact:** Alternative ciphers with different key sizes would need separate KDF implementations.

**Recommendation:** Consider a generic KDF abstraction returning arbitrary-length key material.

---

### 2.7 INFO: Dual-Key Envelope Pattern Not Abstracted

**Location:** `encryption/aes128.nr:214-218`

**Issue:** The header/body split uses two separate AES keys derived from one shared secret:

```noir
let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(
    ciphertext_shared_secret,
);
let (body_sym_key, body_iv) = pairs[0];
let (header_sym_key, header_iv) = pairs[1];
```

This "encrypted envelope with length prefix" pattern is baked into the AES implementation rather than being a reusable abstraction.

---

### 2.8 INFO: ONCHAIN_CONSTRAINED Tagging Not Fully Constrained

**Location:** `message_delivery.nr:127-129`, `message_delivery.nr:207-208`

**Issue:** Already documented in code:
```noir
/// >**WARNING**: this delivery mode is
/// [currently NOT fully constrained](https://github.com/AztecProtocol/aztec-packages/issues/14565).
```

**Impact:** A malicious sender could manipulate the tag to prevent recipients from finding messages even when using `ONCHAIN_CONSTRAINED`.

---

## 3. Documentation Gaps

### 3.1 Security Model Differences Not Documented

The documentation (`docs/messages.md`) does not explain:
- Why AES-128 was chosen over Poseidon2 for production use
- Security/performance tradeoffs between schemes
- Post-quantum considerations (mentioned only in `poseidon2.nr:17`)

### 3.2 No Guidance on Encryption Scheme Selection

Since Poseidon2 exists but isn't integrated, developers may be confused about:
- Whether they should/can use Poseidon2
- When AES vs Poseidon2 would be appropriate
- How to choose between them

### 3.3 Implicit vs Explicit Replay Protection

The AES implementation relies on fresh ephemeral keys for replay resistance, but this is not documented. The Poseidon2 nonce parameter suggests replay protection is a concern, creating inconsistency in the security model.

---

## 4. Recommendations Summary

| Priority | Issue | Recommendation |
|----------|-------|----------------|
| HIGH | No MAC for AES | Implement AES-GCM or add HMAC |
| MEDIUM | Poseidon2 not integrated | Integrate into trait or document deprecation |
| MEDIUM | No replay protection for AES | Document or add explicit nonce support |
| MEDIUM | Hardcoded AES constants | Abstract encryption-specific constants |
| LOW | No ciphertext versioning | Add unencrypted scheme/version prefix |
| LOW | KDF tied to AES | Create generic KDF abstraction |
| INFO | Envelope pattern not abstracted | Consider reusable header/body encryption |
| INFO | Document security model | Add security considerations to docs |

---

## 5. Files Reviewed

- `mod.nr` - Module documentation
- `encoding.nr` - Message plaintext encoding
- `msg_type.nr` - Message type constants
- `encryption/mod.nr` - Encryption module exports
- `encryption/aes128.nr` - AES-128 implementation
- `encryption/poseidon2.nr` - Poseidon2 implementation (not integrated)
- `encryption/message_encryption.nr` - MessageEncryption trait
- `message_delivery.nr` - Delivery mode orchestration
- `offchain_messages.nr` - Off-chain delivery
- `logs/note.nr` - Private note encoding
- `logs/partial_note.nr` - Partial note encoding
- `logs/event.nr` - Private event encoding
- `discovery/mod.nr` - Message discovery
- `discovery/process_message.nr` - Message processing
- `docs/messages.md` - External documentation
