# Aztec Addresses and Contract Deployment Deep Dive

This document provides a comprehensive analysis of address derivation and contract deployment in Aztec, including contract classes, instances, and protocol-level validation. It is intended for security researchers and developers who need to understand how contracts are identified and deployed.

## Overview

Aztec uses a sophisticated system for contract deployment that separates:

1. **Contract Classes**: The code/bytecode (reusable across instances)
2. **Contract Instances**: Deployed instances with unique addresses and state

This separation enables:
- Code reuse without redeployment
- Counterfactual addresses (predictable before deployment)
- Contract upgrades via class ID updates
- Protocol-level verification of function execution

## Address Derivation

An Aztec address is cryptographically derived from multiple components, ensuring that the address commits to both the contract's code and its owner's identity.

### The Address Formula

```
AztecAddress = (pre_address * G + ivpk_m).x

Where:
  pre_address = poseidon2(public_keys_hash, partial_address, DOM_SEP__CONTRACT_ADDRESS_V1)
  public_keys_hash = poseidon2(npk_m, ivpk_m, ovpk_m, tpk_m, DOM_SEP__PUBLIC_KEYS_HASH)
  partial_address = poseidon2(contract_class_id, salted_initialization_hash, DOM_SEP__PARTIAL_ADDRESS)
  salted_initialization_hash = poseidon2(salt, initialization_hash, deployer, DOM_SEP__PARTIAL_ADDRESS)
```

### Visual Hierarchy

```
                           AztecAddress (Field)
                                  ↑
                           address_point.x
                                  ↑
              ┌───────────────────┴───────────────────┐
              │                                       │
      pre_address * G                          +   ivpk_m
              ↑
       poseidon2_hash
              ↑
    ┌─────────┴─────────┐
    │                   │
PublicKeysHash    PartialAddress
    ↑                   ↑
poseidon2_hash    poseidon2_hash
    ↑                   ↑
┌───┴───┐       ┌───────┴───────┐
│       │       │               │
PublicKeys  ContractClassId  SaltedInitHash
(npk_m,         ↑               ↑
ivpk_m,    poseidon2_hash   poseidon2_hash
ovpk_m,         ↑               ↑
tpk_m)   ┌──────┼──────┐    ┌───┼───┐
         │      │      │    │   │   │
    artifact  private  public salt init deployer
    _hash   _functions _bytecode  _hash
              _root    _commitment
```

### Implementation Details

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/address/aztec_address.nr

pub fn compute(public_keys: PublicKeys, partial_address: PartialAddress) -> AztecAddress {
    let public_keys_hash = public_keys.hash();

    let pre_address = poseidon2_hash_with_separator(
        [public_keys_hash.to_field(), partial_address.to_field()],
        DOM_SEP__CONTRACT_ADDRESS_V1,
    );

    // Address point combines pre_address with incoming viewing public key
    let address_point = derive_public_key(EmbeddedCurveScalar::from_field(pre_address)).add(
        public_keys.ivpk_m.to_point(),
    );

    // Address is just the x-coordinate
    AztecAddress::from_field(address_point.x)
}
```

**Why include `ivpk_m` in the address?**

The incoming viewing public key is added to the address point so that:
1. Anyone can derive a shared secret with the address owner using ECDH
2. No separate key lookup is needed—the address itself embeds encryption capability
3. The y-coordinate can be recovered from x using the curve equation `y² = x³ - 17`

### Partial Address

The partial address encodes contract-specific information without the owner's keys:

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/address/partial_address.nr

impl PartialAddress {
    pub fn compute(
        contract_class_id: ContractClassId,
        salt: Field,
        initialization_hash: Field,
        deployer: AztecAddress,
    ) -> Self {
        PartialAddress::compute_from_salted_initialization_hash(
            contract_class_id,
            SaltedInitializationHash::compute(salt, initialization_hash, deployer),
        )
    }

    pub fn compute_from_salted_initialization_hash(
        contract_class_id: ContractClassId,
        salted_initialization_hash: SaltedInitializationHash,
    ) -> Self {
        PartialAddress::from_field(poseidon2_hash_with_separator(
            [contract_class_id.to_field(), salted_initialization_hash.to_field()],
            DOM_SEP__PARTIAL_ADDRESS,
        ))
    }
}
```

### Salted Initialization Hash

The initialization hash commits to the constructor call:

```noir
// From: noir-projects/aztec-nr/aztec/src/macros/functions/initialization_utils.nr

pub fn compute_initialization_hash(
    init_selector: FunctionSelector,
    init_args_hash: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [init_selector.to_field(), init_args_hash],
        DOM_SEP__CONSTRUCTOR,
    )
}
```

The salted initialization hash then includes salt and deployer:

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/address/salted_initialization_hash.nr

pub fn compute(salt: Field, initialization_hash: Field, deployer: AztecAddress) -> Self {
    SaltedInitializationHash::from_field(poseidon2_hash_with_separator(
        [salt, initialization_hash, deployer.to_field()],
        DOM_SEP__PARTIAL_ADDRESS,
    ))
}
```

### Address Point Recovery

When encrypting to an address, the sender recovers the full curve point:

```noir
pub fn to_address_point(self) -> Option<AddressPoint> {
    let x = self.inner;
    let y_squared = pow(x, 3) - 17;  // BN254 curve equation

    let y_opt = sqrt(y_squared);
    if y_opt.is_none() {
        Option::none()  // Invalid address (no point on curve)
    } else {
        let mut y = y_opt.unwrap();

        // Canonicalize to positive y (y <= MAX_FIELD_VALUE / 2)
        if (!(y.lt(MAX_FIELD_VALUE / 2) | y.eq(MAX_FIELD_VALUE / 2))) {
            y = (MAX_FIELD_VALUE + 1) - y;
        }

        Option::some(AddressPoint { inner: Point { x, y, is_infinite: false } })
    }
}
```

**Security Note**: Invalid addresses (where `x³ - 17` has no square root in the field) cannot receive encrypted messages.

## Contract Classes

A contract class represents reusable contract code, identified by a `ContractClassId`.

### ContractClassId Computation

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/contract_class_id.nr

impl ContractClassId {
    pub fn compute(
        artifact_hash: Field,
        private_functions_root: Field,
        public_bytecode_commitment: Field,
    ) -> Self {
        let hash = poseidon2_hash_with_separator(
            [artifact_hash, private_functions_root, public_bytecode_commitment],
            DOM_SEP__CONTRACT_CLASS_ID,
        );
        ContractClassId::from_field(hash)
    }
}
```

**Components**:

| Component | Description |
|-----------|-------------|
| `artifact_hash` | Hash of contract metadata (ABI, etc.) |
| `private_functions_root` | Merkle root of private function VK hashes |
| `public_bytecode_commitment` | Commitment to public (AVM) bytecode |

### Contract Class Registration

Classes are registered via the `ContractClassRegistry` protocol contract:

```noir
// From: noir-projects/noir-contracts/contracts/protocol/contract_class_registry/src/main.nr

#[external("private")]
fn publish(
    artifact_hash: Field,
    private_functions_root: Field,
    public_bytecode_commitment: Field,
) {
    // Load and verify public bytecode
    let packed_public_bytecode = unsafe {
        capsules::load(self.address, CONTRACT_CLASS_REGISTRY_BYTECODE_CAPSULE_SLOT).unwrap()
    };
    let computed_public_bytecode_commitment =
        compute_public_bytecode_commitment(packed_public_bytecode);
    assert_eq(computed_public_bytecode_commitment, public_bytecode_commitment);

    // Compute contract class id
    let contract_class_id = ContractClassId::compute(
        artifact_hash,
        private_functions_root,
        public_bytecode_commitment,
    );

    // Emit class id as nullifier (proves uniqueness, enables lookups)
    self.context.push_nullifier(contract_class_id.to_field());

    // Broadcast class info via log
    let event = ContractClassPublished { ... };
    self.context.emit_contract_class_log(event.serialize_non_standard());
}
```

**Registration guarantees**:
1. **Uniqueness**: The class ID is emitted as a nullifier, preventing duplicate registration
2. **Availability**: Other contracts can read nullifier existence to verify registration
3. **Bytecode integrity**: Public bytecode commitment is verified against actual bytecode

## Contract Instances

A contract instance is a deployed contract with a unique address and state.

### ContractInstance Structure

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/contract_instance.nr

pub struct ContractInstance {
    pub salt: Field,
    pub deployer: AztecAddress,
    pub contract_class_id: ContractClassId,
    pub initialization_hash: Field,
    pub public_keys: PublicKeys,
}

impl ContractInstance {
    pub fn to_address(self) -> AztecAddress {
        AztecAddress::compute(
            self.public_keys,
            PartialAddress::compute(
                self.contract_class_id,
                self.salt,
                self.initialization_hash,
                self.deployer,
            ),
        )
    }
}
```

### Instance Publishing

Instances are published via the `ContractInstanceRegistry`:

```noir
// From: noir-projects/noir-contracts/contracts/protocol/contract_instance_registry/src/main.nr

#[external("private")]
fn publish_for_public_execution(
    salt: Field,
    contract_class_id: ContractClassId,
    initialization_hash: Field,
    public_keys: PublicKeys,
    universal_deploy: bool,
) {
    // Verify class is registered
    self.context.push_nullifier_read_request(
        contract_class_id.to_field(),
        CONTRACT_CLASS_REGISTRY_CONTRACT_ADDRESS,
    );

    let deployer = if universal_deploy {
        AztecAddress::zero()
    } else {
        self.msg_sender().unwrap()
    };

    // Compute the address
    let partial_address = PartialAddress::compute(
        contract_class_id, salt, initialization_hash, deployer
    );
    let address = AztecAddress::compute(public_keys, partial_address);

    // Emit address as nullifier (proves uniqueness, enables lookups)
    self.context.push_nullifier(address.to_field());

    // Broadcast instance info
    let event = ContractInstancePublished { ... };
    self.context.emit_private_log(event.serialize_non_standard(), length);
}
```

### Universal vs Restricted Deployment

| Deployment Type | Deployer Field | Who Can Initialize |
|-----------------|----------------|-------------------|
| Universal | `AztecAddress::zero()` | Anyone |
| Restricted | `msg_sender` | Only the deployer |

## Contract Initialization

Contracts must be initialized (constructor called) before use.

### Initialization Nullifier

When a contract's constructor runs, it emits an "initialization nullifier":

```noir
// From: noir-projects/aztec-nr/aztec/src/macros/functions/initialization_utils.nr

fn compute_unsiloed_contract_initialization_nullifier(address: AztecAddress) -> Field {
    address.to_field()
}

pub fn mark_as_initialized_private(context: &mut PrivateContext) {
    let init_nullifier = compute_unsiloed_contract_initialization_nullifier(context.this_address());
    context.push_nullifier(init_nullifier);
}
```

### Initialization Validation

When a constructor runs, it validates the arguments match the address preimage:

```noir
pub fn assert_initialization_matches_address_preimage_private(context: PrivateContext) {
    let address = context.this_address();
    let instance = get_contract_instance(address);

    // Compute expected initialization hash from actual constructor call
    let expected_init = compute_initialization_hash(
        context.selector(),
        context.get_args_hash()
    );

    // Verify it matches what was committed in the address
    assert(instance.initialization_hash == expected_init,
        "Initialization hash does not match");

    // Verify deployer authorization
    assert(
        (instance.deployer.is_zero()) | (instance.deployer == context.msg_sender().unwrap()),
        "Initializer address is not the contract deployer",
    );
}
```

### Pre-Initialization Checks

Before any non-constructor function runs, it checks the contract is initialized:

```noir
pub fn assert_is_initialized_private(context: &mut PrivateContext) {
    let init_nullifier = compute_unsiloed_contract_initialization_nullifier(context.this_address());
    context.push_nullifier_read_request(init_nullifier, context.this_address());
}
```

## Protocol-Level Address Validation

The kernel circuits validate that private functions belong to the claimed contract.

### Validation Flow

```noir
// From: noir-projects/noir-protocol-circuits/crates/private-kernel-lib/src/components/
//       private_call_data_validator/validate_contract_address.nr

pub fn validate_contract_address(
    private_call_data: PrivateCallData,
    protocol_contracts: ProtocolContracts,
) {
    let contract_address = private_call_data.public_inputs.call_context.contract_address;

    // Step 1: Compute the class id and address from the function being executed

    let function_selector = private_call_data.public_inputs.call_context.function_selector;
    let vk_hash = private_call_data.vk.hash;
    let hints = private_call_data.verification_key_hints;

    // Prove function exists in contract's private functions tree
    let private_functions_root = private_functions_root_from_siblings(
        function_selector,
        vk_hash,
        hints.function_leaf_membership_witness.leaf_index,
        hints.function_leaf_membership_witness.sibling_path,
    );

    // Compute class id from the root
    let computed_contract_class_id = ContractClassId::compute(
        hints.contract_class_artifact_hash,
        private_functions_root,
        hints.contract_class_public_bytecode_commitment,
    );

    // Compute expected address
    let computed_address = AztecAddress::compute_from_class_id(
        computed_contract_class_id,
        hints.salted_initialization_hash,
        hints.public_keys,
    );

    // Step 2: Check if it's a protocol contract
    let is_protocol_contract = ProtocolContracts::is_protocol_contract_address(contract_address);
    if is_protocol_contract {
        let expected = protocol_contracts.get_derived_address(contract_address);
        assert(computed_address == expected,
            "computed contract address does not match protocol contract derived address");
    }

    // Step 3: Check if it's an updated contract
    let updated_contract_class_id = get_updated_contract_class_id(...);
    let is_updated_contract = !updated_contract_class_id.is_empty();
    if is_updated_contract {
        assert(computed_contract_class_id == updated_contract_class_id,
            "computed contract class id does not match updated contract class id");
    }

    // Step 4: If neither, must be a regular contract
    let is_regular_contract = !is_protocol_contract & !is_updated_contract;
    if is_regular_contract {
        assert(computed_address == contract_address,
            "computed contract address does not match expected one");
    }
}
```

**What this proves**:
1. The function's VK hash is in the contract's private functions merkle tree
2. The contract class ID correctly derives from the functions root
3. The contract address correctly derives from the class ID and other components
4. The function being executed belongs to the contract it claims to be from

## Protocol Contracts

Protocol contracts have special "magic" addresses (1, 2, 3, ...) that map to derived addresses.

### Magic Addresses

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/constants.nr

pub global MAX_PROTOCOL_CONTRACTS: u32 = 11;
pub global CANONICAL_AUTH_REGISTRY_ADDRESS: AztecAddress = AztecAddress::from_field(1);
pub global CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS: AztecAddress = AztecAddress::from_field(2);
pub global CONTRACT_CLASS_REGISTRY_CONTRACT_ADDRESS: AztecAddress = AztecAddress::from_field(3);
pub global MULTI_CALL_ENTRYPOINT_ADDRESS: AztecAddress = AztecAddress::from_field(4);
pub global FEE_JUICE_ADDRESS: AztecAddress = AztecAddress::from_field(5);
pub global ROUTER_ADDRESS: AztecAddress = AztecAddress::from_field(6);
// ... etc
```

### Protocol Contract Structure

```noir
// From: noir-projects/noir-protocol-circuits/crates/types/src/abis/protocol_contracts.nr

pub struct ProtocolContracts {
    derived_addresses: [AztecAddress; MAX_PROTOCOL_CONTRACTS],
}

impl ProtocolContracts {
    /// Checks if the given address is a protocol contract address (1 to MAX_PROTOCOL_CONTRACTS).
    pub fn is_protocol_contract_address(contract_address: AztecAddress) -> bool {
        (contract_address.to_field() - 1).lt(MAX_PROTOCOL_CONTRACTS as Field)
    }

    /// Gets the actual derived address for a protocol contract's magic address.
    pub fn get_derived_address(self, protocol_contract_address: AztecAddress) -> AztecAddress {
        self.derived_addresses[(protocol_contract_address.to_field() - 1) as u32]
    }
}
```

## Contract Upgrades

Contracts can upgrade to a new class ID via the registry:

```noir
// From: noir-projects/noir-contracts/contracts/protocol/contract_instance_registry/src/main.nr

#[external("public")]
fn update(new_contract_class_id: ContractClassId) {
    let address = self.msg_sender().unwrap();

    // Verify contract is deployed
    assert(self.context.nullifier_exists_unsafe(address.to_field(), self.address),
        "msg.sender is not deployed");

    // Verify new class is registered
    assert(self.context.nullifier_exists_unsafe(
        new_contract_class_id.to_field(),
        CONTRACT_CLASS_REGISTRY_CONTRACT_ADDRESS
    ), "New contract class is not registered");

    // Schedule the update (with delay for safety)
    let scheduled_value_update = self.storage.updated_class_ids
        .at(address)
        .schedule_and_return_value_change(new_contract_class_id);

    // Emit update event
    let event = ContractInstanceUpdated { ... };
    self.context.emit_public_log(event);
}
```

**Security Properties**:
- Updates are delayed (configurable delay, minimum enforced)
- Only the contract itself can trigger its own upgrade
- The new class must be registered

## Getting Contract Instances

### In Private Functions

```noir
// From: noir-projects/aztec-nr/aztec/src/oracle/get_contract_instance.nr

pub fn get_contract_instance(address: AztecAddress) -> ContractInstance {
    // Safety: The to_address function combines all values in the instance object
    // to produce an address, so by checking that we get the expected address
    // we validate the entire struct.
    let instance = unsafe { get_contract_instance_internal(address) };
    assert_eq(instance.to_address(), address);

    instance
}
```

### In Public Functions (AVM)

```noir
pub fn get_contract_instance_deployer_avm(address: AztecAddress) -> Option<AztecAddress> {
    // Safety: AVM opcodes are constrained by the AVM itself
    let GetContractInstanceResult { exists, member } =
        unsafe { get_contract_instance_deployer_internal_avm(address)[0] };
    if exists {
        Option::some(AztecAddress::from_field(member))
    } else {
        Option::none()
    }
}
```

## Security Considerations

### Address Collision Resistance

Addresses are collision-resistant due to:
1. **Poseidon2 hash function**: Cryptographically secure
2. **Domain separators**: Each hash uses unique domain separators
3. **Multiple inputs**: salt, deployer, keys, class ID all contribute

### Counterfactual Deployment

Addresses can be computed before deployment:
- **Benefit**: Enables receiving funds before contract deployment
- **Risk**: If private keys are compromised, funds at counterfactual address can be stolen by deploying with attacker's keys

### Class ID Integrity

The kernel validates that:
1. The function VK is in the contract's merkle tree
2. The class ID derives from that merkle root
3. The address derives from that class ID

**This prevents**:
- Calling functions that don't belong to the contract
- Spoofing contract identity
- Executing unregistered code

### Universal Deployment Risks

Universal deployment (`deployer = 0`) allows anyone to initialize:
- **Use case**: Shared infrastructure contracts
- **Risk**: Attacker could front-run initialization with malicious parameters

## Summary

| Component | Purpose | Computation |
|-----------|---------|-------------|
| `ContractClassId` | Identifies code | `hash(artifact_hash, private_functions_root, public_bytecode_commitment)` |
| `PartialAddress` | Contract-specific part of address | `hash(class_id, salted_init_hash)` |
| `SaltedInitHash` | Commits to constructor + deployer | `hash(salt, init_hash, deployer)` |
| `PublicKeysHash` | Owner identity | `hash(npk_m, ivpk_m, ovpk_m, tpk_m)` |
| `AztecAddress` | Full contract address | `(hash(keys_hash, partial_addr) * G + ivpk_m).x` |

The address derivation creates a cryptographic binding between:
- **Code**: What the contract does (class ID)
- **Configuration**: How it was initialized (init hash, salt)
- **Ownership**: Who controls it (public keys)
- **Authorization**: Who deployed it (deployer)

This enables the kernel to validate that any function execution is authorized by the contract's address preimage, preventing impersonation attacks.
