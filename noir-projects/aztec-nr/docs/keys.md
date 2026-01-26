# Aztec Cryptographic Keys Deep Dive

This document provides a comprehensive analysis of the cryptographic key infrastructure in Aztec, covering key types, derivation, usage patterns, and protocol enforcement mechanisms. It is intended for security researchers and developers who need to understand the cryptographic foundations of the protocol.

## Overview

Aztec uses a sophisticated key hierarchy to provide:

- **Privacy**: Encrypting notes and logs so only intended recipients can read them
- **Authorization**: Proving ownership of notes for nullification
- **Discovery**: Enabling recipients to find their messages efficiently
- **Separation of concerns**: Different keys for different purposes prevent cross-contamination of secrets

There are **four master key types**, each with a specific purpose:

| Key Type         | Abbreviation  | Purpose                      |
| ---------------- | ------------- | ---------------------------- |
| Nullifier        | nsk_m/npk_m   | Authorizing note consumption |
| Incoming Viewing | ivsk_m/ivpk_m | Decrypting incoming notes    |
| Outgoing Viewing | ovsk_m/ovpk_m | Decrypting outgoing notes    |
| Tagging          | tsk_m/tpk_m   | Message discovery            |

Each key type has both a **secret key** (sk) and **public key** (pk) component, where:

- `sk` = scalar on the elliptic curve
- `pk` = point on the curve, derived as `pk = sk * G` (G is the generator point)

## Key Hierarchy

```
                    Master Secret Seed
                           │
           ┌───────────────┼───────────────┬───────────────┐
           ▼               ▼               ▼               ▼
        nsk_m           ivsk_m          ovsk_m          tsk_m
           │               │               │               │
     fixed_base_mul   fixed_base_mul  fixed_base_mul  fixed_base_mul
           ▼               ▼               ▼               ▼
        npk_m           ivpk_m          ovpk_m          tpk_m
           │               │               │               │
           └───────────────┴───────────────┴───────────────┘
                                   │
                                   ▼
                            PublicKeys struct
                                   │
                               hash()
                                   ▼
                          PublicKeysHash
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             PartialAddress                     ivpk_m
                    │                             │
                    └──────────────┬──────────────┘
                                   ▼
                            AztecAddress
```

### PublicKeys Structure

The four master public keys are grouped in a `PublicKeys` struct:

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/public_keys.nr

pub struct PublicKeys {
    pub npk_m: NpkM,      // Master nullifier public key
    pub ivpk_m: IvpkM,    // Master incoming viewing public key
    pub ovpk_m: OvpkM,    // Master outgoing viewing public key
    pub tpk_m: TpkM,      // Master tagging public key
}
```

Each key type is a wrapper around an elliptic curve `Point`:

```noir
pub struct NpkM {
    pub inner: Point,
}
```

## Address Derivation

The Aztec address is cryptographically derived from the user's public keys. This is critical because it allows anyone to encrypt messages to an address without needing separate key exchange.

### Address Computation

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/address/aztec_address.nr

pub fn compute(public_keys: PublicKeys, partial_address: PartialAddress) -> AztecAddress {
    let public_keys_hash = public_keys.hash();

    let pre_address = poseidon2_hash_with_separator(
        [public_keys_hash.to_field(), partial_address.to_field()],
        DOM_SEP__CONTRACT_ADDRESS_V1,
    );

    // Address point = pre_address * G + ivpk_m
    let address_point = derive_public_key(EmbeddedCurveScalar::from_field(pre_address)).add(
        public_keys.ivpk_m.to_point(),
    );

    // Address is just the x-coordinate
    AztecAddress::from_field(address_point.x)
}
```

**Key insight**: The address incorporates `ivpk_m` (incoming viewing public key), which means:

1. Anyone can derive the `address_point` from just the x-coordinate (the address) by solving `y² = x³ - 17`
2. This allows ECDH key exchange directly with an address, without needing to look up keys separately
3. The partial address encodes contract-specific information (class ID, salt, initialization hash)

### Address Point Recovery

When someone wants to encrypt to an address, they can recover the full curve point:

```noir
pub fn to_address_point(self) -> Option<AddressPoint> {
    let x = self.inner;
    let y_squared = pow(x, 3) - 17;  // BN254 curve equation

    // Compute square root if it exists
    let maybe_y = sqrt(y_squared);

    if maybe_y.is_some() {
        // Choose the y with smaller value (canonical form)
        let y = if maybe_y.unwrap() > (0 - maybe_y.unwrap()) {
            0 - maybe_y.unwrap()
        } else {
            maybe_y.unwrap()
        };
        Option::some(AddressPoint { inner: Point { x, y, is_infinite: false } })
    } else {
        Option::none()  // Invalid address
    }
}
```

## Key Types in Detail

### 1. Nullifier Keys (nsk_m / npk_m)

**Purpose**: Authorizing the consumption (nullification) of notes.

The nullifier secret key is used to compute deterministic nullifiers for notes. Without the `nsk_m`, no one can compute the nullifier and thus cannot spend the note.

#### Nullifier Computation

```noir
// From: noir-projects/aztec-nr/uint-note/src/uint_note.nr

fn compute_nullifier(
    self,
    context: &mut PrivateContext,
    owner: AztecAddress,
    note_hash_for_nullification: Field,
) -> Field {
    let owner_npk_m = get_public_keys(owner).npk_m;
    let owner_npk_m_hash = owner_npk_m.hash();

    // Request the app-siloed nullifier secret key
    let secret = context.request_nsk_app(owner_npk_m_hash);

    poseidon2_hash_with_separator(
        [note_hash_for_nullification, secret],
        DOM_SEP__NOTE_NULLIFIER,
    )
}
```

**Security Properties**:

- Only the note owner can compute the nullifier
- The nullifier reveals nothing about the note content (it's a hash)
- The `npk_m_hash` is stored in notes to identify the owner

### 2. Incoming Viewing Keys (ivsk_m / ivpk_m)

**Purpose**: Decrypting notes and messages that others send to you.

The incoming viewing public key is embedded in the address itself, enabling direct ECDH key exchange with just an address.

#### Usage in Encryption

Messages are encrypted using ECDH with ephemeral keys:

```noir
// From: noir-projects/aztec-nr/aztec/src/keys/ecdh_shared_secret.nr

/// Computes ECDH shared secret: secret * public_key = shared_secret
///
/// E.g.:
/// Epk = esk * G  // ephemeral key-pair
/// Pk = sk * G    // recipient key-pair
/// Shared secret S = esk * Pk = sk * Epk
pub fn derive_ecdh_shared_secret(secret: Scalar, public_key: Point) -> Point {
    multi_scalar_mul([public_key], [secret])
}
```

The shared secret is then used as input to symmetric encryption (Poseidon2 or AES128).

### 3. Outgoing Viewing Keys (ovsk_m / ovpk_m)

**Purpose**: Decrypting records of notes you've sent to others.

This separation allows users to:

- Keep records of what they've sent
- Potentially share outgoing viewing capability without compromising incoming privacy
- Track spending history

#### When Used

The `ovsk_app` is requested when creating encrypted logs for notes the sender creates:

```noir
pub fn request_ovsk_app(&mut self, ovpk_m_hash: Field) -> Field {
    self.request_sk_app(ovpk_m_hash, OUTGOING_INDEX)
}
```

### 4. Tagging Keys (tsk_m / tpk_m)

**Purpose**: Efficient message discovery without scanning all logs.

Tagging allows recipients to find their messages by looking up specific tags, rather than attempting to decrypt every message on the network.

## App-Siloed Keys

A critical security mechanism is **app-siloing**: master secret keys are never exposed to application contracts. Instead, applications receive app-siloed versions that are specific to both the key owner and the contract.

### App Secret Key Derivation

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/hash.nr

pub fn compute_app_secret_key(
    master_secret_key: EmbeddedCurveScalar,
    app_address: AztecAddress,
    app_secret_generator: Field,  // Domain separator for key type
) -> Field {
    poseidon2_hash_with_separator(
        [master_secret_key.hi, master_secret_key.lo, app_address.to_field()],
        app_secret_generator,
    )
}
```

**Key Properties**:

- `nsk_app = hash(nsk_m, contract_address, DOM_SEP__NSK_M)`
- Different contracts get different app-siloed keys
- Compromise of one contract's key doesn't compromise others
- The kernel validates these derivations, not the app

### Key Indices and Domain Separators

```noir
// From: noir-projects/aztec-nr/aztec/src/keys/constants.nr

pub global NULLIFIER_INDEX: Field = 0;
pub global INCOMING_INDEX: Field = 1;
pub global OUTGOING_INDEX: Field = 2;
pub global TAGGING_INDEX: Field = 3;

pub global sk_generators: [Field; 4] = [
    DOM_SEP__NSK_M as Field,   // 48
    DOM_SEP__IVSK_M as Field,  // 49
    DOM_SEP__OVSK_M as Field,  // 50
    DOM_SEP__TSK_M as Field,   // 51
];
```

## Protocol-Level Key Validation

The kernel circuits enforce correct key derivation through **Key Validation Requests**. This is how the protocol ensures apps can't forge or misuse keys.

### Key Validation Request Flow

1. **App requests a key**: Contract calls `context.request_nsk_app(npk_m_hash)`

2. **Oracle provides key**: PXE returns the app-siloed secret key

3. **Request recorded**: The request is added to the circuit's outputs:

```noir
// From: noir-projects/aztec-nr/aztec/src/context/private_context.nr

fn request_sk_app(&mut self, pk_m_hash: Field, key_index: Field) -> Field {
    let request = unsafe { get_key_validation_request(pk_m_hash, key_index) };
    assert_eq(request.pk_m.hash(), pk_m_hash, "Obtained invalid key validation request");

    self.key_validation_requests_and_generators.push(
        KeyValidationRequestAndGenerator {
            request,
            sk_app_generator: sk_generators[key_index as u32],
        },
    );

    request.sk_app
}
```

4. **Kernel validates**: The reset circuit receives the master secret key and verifies:

```noir
// From: noir-projects/noir-protocol-circuits/crates/private-kernel-lib/src/reset/
//       key_validation_request/validate_key_validation_request.nr

pub fn validate_key_validation_request(
    scoped_request: Scoped<KeyValidationRequestAndGenerator>,
    sk_m: Scalar,
) {
    let request = scoped_request.inner.request;
    let sk_app_generator = scoped_request.inner.sk_app_generator;
    let contract_address = scoped_request.contract_address;

    // Verify: sk_m * G == pk_m (the public key matches the secret key)
    let pk_m = derive_public_key(sk_m);
    assert_eq(pk_m, request.pk_m,
        "Failed to derive matching master public key from the secret key");

    // Verify: hash(sk_m, contract, generator) == sk_app
    let sk_app = compute_app_secret_key(sk_m, contract_address, sk_app_generator);
    assert_eq(sk_app, request.sk_app,
        "Failed to derive matching app secret key from the secret key");
}
```

### Security Implications

- **Apps never see master keys**: Only the kernel handles `sk_m`
- **Correct derivation is proven**: The kernel proves the relationship between `sk_m`, `pk_m`, and `sk_app`
- **Scoped to contracts**: The validation includes `contract_address`, preventing cross-contract key reuse attacks
- **Public key binding**: `pk_m_hash` is checked, ensuring the app requested a key for the correct public key

## Ephemeral Keys

For ECDH encryption, ephemeral key pairs are generated per-message:

```noir
// From: noir-projects/aztec-nr/aztec/src/keys/ephemeral.nr

pub fn generate_ephemeral_key_pair() -> (Scalar, Point) {
    // Safety: randomness preserves privacy of sender/recipient via encryption.
    // A malicious sender could use non-random values to reveal plaintext,
    // but they already know the plaintext anyway.
    let randomness = unsafe { random() };

    let eph_sk = EmbeddedCurveScalar::from_field(randomness);
    let eph_pk = fixed_base_scalar_mul(eph_sk);

    (eph_sk, eph_pk)
}
```

**Properties**:

- New key pair for each encrypted message
- Provides forward secrecy: compromising long-term keys doesn't reveal past messages
- Ephemeral public key is included in the ciphertext for recipient to compute shared secret

## Encryption Schemes

### Poseidon2 Encryption

A ZK-friendly encryption scheme using the Poseidon2 permutation:

```noir
// From: noir-projects/aztec-nr/aztec/src/messages/encryption/poseidon2.nr

pub fn poseidon2_encrypt<let L: u32>(
    msg: [Field; L],
    shared_secret: Point,
    encryption_nonce: Field,
) -> [Field; ((L + 2) / 3) * 3 + 1] {
    let mut s = [0, shared_secret.x, shared_secret.y,
                 encryption_nonce + (L as Field) * TWO_POW_128];

    // Sponge construction: absorb plaintext, release ciphertext
    for i in 0..CEIL {
        s = poseidon2_permutation(s, 4);
        // Absorb and release...
    }
    // Final MAC
    c[L_UPPER_BOUND] = s[1];
    c
}
```

**Trade-offs**:

- Very efficient in ZK circuits (~160 constraints for 8 fields)
- Relatively new, less battle-tested than AES
- No post-quantum security

### AES128 Encryption

Also available for more traditional security guarantees, but more expensive in circuits.

## Getting Public Keys

Apps can retrieve public keys for any account:

```noir
// From: noir-projects/aztec-nr/aztec/src/keys/getters/mod.nr

pub fn get_public_keys(account: AztecAddress) -> PublicKeys {
    // Safety: Public keys are constrained by showing their inclusion
    // in the address's preimage.
    let (public_keys, partial_address) =
        unsafe { get_public_keys_and_partial_address(account) };

    assert_eq(
        account,
        AztecAddress::compute(public_keys, partial_address),
        "Invalid public keys hint for address",
    );

    public_keys
}
```

**Constraint**: The oracle-provided keys must hash to the address, preventing spoofed keys.

## Security Considerations

### Key Exposure Risks

1. **nsk_m compromise**: Attacker can nullify (spend) all notes
2. **ivsk_m compromise**: Attacker can read all incoming notes (current and future)
3. **ovsk_m compromise**: Attacker can see all outgoing transaction history
4. **tsk_m compromise**: Attacker can identify which messages are for the user

### Protocol Protections

1. **App-siloing**: Even if an app is malicious, it can only leak the app-siloed key, not the master key
2. **Kernel validation**: All key usage goes through kernel verification
3. **Address binding**: Keys are cryptographically bound to addresses
4. **Domain separation**: Different key types use different hash separators

### Note on npk_m_hash in Notes

Notes typically store `npk_m_hash` (not `npk_m` itself):

```noir
// Common note pattern
pub struct ValueNote {
    pub value: Field,
    pub npk_m_hash: Field,  // Identifies owner for nullification
    pub randomness: Field,
}
```

This serves two purposes:

1. **Compactness**: Hash is one field vs two for a point
2. **Privacy**: Doesn't directly reveal the public key (though it's derivable from address)

## Key Discovery and Message Processing

When processing incoming messages, the PXE:

1. Scans for tagged logs using tagging keys
2. Attempts decryption using incoming viewing keys
3. Extracts note preimages
4. Stores notes with their nullifier key information

For nullifying notes:

1. Looks up the note's `npk_m_hash`
2. Requests `nsk_app` from the kernel via `request_nsk_app(npk_m_hash)`
3. Computes the nullifier
4. Emits the nullifier to prevent double-spending

## Summary

The Aztec key system provides:

| Feature             | Mechanism                                      |
| ------------------- | ---------------------------------------------- |
| Note ownership      | npk_m_hash in notes, nsk_app for nullification |
| Incoming privacy    | ECDH with ivpk_m embedded in address           |
| Outgoing records    | Separate ovpk_m for sender-side decryption     |
| Message discovery   | Tagging system with tpk_m                      |
| Cross-app isolation | App-siloed keys via poseidon2 hash             |
| Key integrity       | Kernel validates all key derivations           |
| Forward secrecy     | Ephemeral keys for each encryption             |

The protocol enforces these properties through the kernel circuits, which validate key usage without exposing master secrets to application code.
