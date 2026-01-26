# Security Findings

---

## FINDING-006: Missing plaintext length validation in AES128::encrypt

**Severity:** Medium
**File:** `aztec/src/messages/encryption/aes128.nr:159`

### Description

`AES128::encrypt` accepts any `PlaintextLen` but outputs a fixed `[Field; MESSAGE_CIPHERTEXT_LEN]`. When `PlaintextLen > MESSAGE_PLAINTEXT_LEN` (14 fields), line 323 causes an out-of-bounds runtime error.

### Impact

This enables a "king of the hill" attack: if an attacker can influence the plaintext length (e.g., by providing data that gets encoded into a message), they could force a contract to attempt encrypting an oversized message. The resulting runtime failure makes the transaction impossible, causing denial of service. This is the same attack pattern documented in the invalid address handling (lines 186-190).

### Recommendation

Add at the start of `encrypt`:
```noir
std::static_assert(
    PlaintextLen <= MESSAGE_PLAINTEXT_LEN,
    "plaintext exceeds maximum message capacity",
);
```

---

## FINDING-005: Redundant intermediate array in AES key derivation

**Severity:** Efficiency
**File:** `aztec/src/messages/encryption/aes128.nr:47-154`

### Description

`derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe` creates a `[[u8; 32]; N]` intermediate array via `extract_many_close_to_uniformly_random_256_bits...`, then immediately splits each 32-byte array into two 16-byte arrays (key, iv) in `derive_aes_symmetric_key_and_iv_from_uniformly_random_256_bits`.

### Recommendation

Combine into a single function that directly populates `([u8; 16], [u8; 16])` pairs from the poseidon2 hash outputs, eliminating the intermediate allocation and one copy pass.

---

## FINDING-004: Inline division could use precomputed constant

**Severity:** Efficiency
**File:** `noir-protocol-circuits/crates/types/src/address/aztec_address.nr:73-74`

### Description

`MAX_FIELD_VALUE / 2` is computed inline for y-coordinate sign checking, but `BN254_FR_MODULUS_DIV_2` already exists as a precomputed constant in `aztec-nr/aztec/src/utils/point.nr`.

### Recommendation

Export and reuse the existing constant, or add `MAX_FIELD_VALUE_DIV_2` to `constants.nr`.

---

## FINDING-003: No versioning in encrypted message format

**Severity:** Medium
**File:** `aztec/src/messages/encryption/aes128.nr`, `aztec/src/messages/encoding.nr`

### Description

The encrypted message format has no unencrypted version or scheme identifier. The `msg_type_id` (note/event/partial) is inside the encrypted payload, leaving no external indicator of:
- Which encryption scheme was used (AES-128 vs future alternatives)
- Which message format version is in use

### Impact

- **Migration risk**: Changing encryption schemes requires recipients to trial-decrypt with multiple methods
- **Compatibility**: Old clients cannot gracefully reject messages in unknown formats
- **Debugging**: No way to identify message type without successful decryption

### Recommendation

Add an unencrypted prefix byte before the ephemeral public key indicating encryption scheme and format version. This enables graceful protocol evolution without breaking backward compatibility.

---

## FINDING-002: AES-128 encryption lacks message authentication (MAC)

**Severity:** Low
**File:** `aztec/src/messages/encryption/aes128.nr`

### Description

The AES-128 encryption implementation provides confidentiality but not integrity/authenticity. Unlike `poseidon2_encrypt` which includes MAC verification (lines 133-137), `AES128::decrypt` has no equivalent check—it returns `Some(data)` for any ciphertext with a valid ephemeral public key, even if tampered.

### Defense in Depth (Caveats)

Several incidental checks provide partial protection:
1. **Ephemeral public key validation** - must be on the curve, else `None`
2. **Field modulus check** - decrypted garbage bytes must form valid field elements
3. **PKCS#7 padding validation** - invalid padding causes decryption failure
4. **Structural validation** - `msg_type_id` checks after decryption catch some corruption

These are format constraints, not cryptographic authentication. An attacker with message structure knowledge could craft tampering that bypasses all format checks (~1-5% of random modifications succeed).

### Impact

Low. While theoretically exploitable, practical attacks require:
- Ability to intercept and modify ciphertexts in transit
- Crafting modifications that pass all format constraints
- A recipient that processes corrupted data without additional validation

### Recommendation

Consider implementing AES-GCM or adding HMAC for authenticated encryption. Alternatively, document that application-level validation is required after decryption.

---

## FINDING-001: MessageDelivery encryption constraint logic is inverted

**Severity:** Medium
**File:** `aztec/src/messages/message_delivery.nr:205-213`

### Description

The encryption constraint logic is inverted. `ONCHAIN_CONSTRAINED` removes encryption constraints while `ONCHAIN_UNCONSTRAINED` keeps them:

```noir
let constrained_encryption = delivery_mode == MessageDelivery.ONCHAIN_UNCONSTRAINED;
let ciphertext = remove_constraints_if(
    !constrained_encryption,  // false for CONSTRAINED mode -> constraints removed
    || AES128::encrypt(encode_into_message_plaintext(), recipient),
);
```

### Impact

Users of `ONCHAIN_CONSTRAINED` are not getting constrained encryption as documented. A malicious sender could provide incorrectly encrypted messages.

### Fix

Change line 205 to:
```noir
let constrained_encryption = delivery_mode == MessageDelivery.ONCHAIN_CONSTRAINED;
```
