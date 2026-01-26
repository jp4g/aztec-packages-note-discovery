# Kernel Interface Documentation

This document describes the interfaces between aztec-nr (the smart contract development framework) and the Aztec protocol kernel circuits. Understanding these boundaries is essential for comprehending how contracts communicate their execution results to the protocol layer.

## Overview

Aztec uses a multi-kernel architecture where:
- **Private functions** execute on the user's device and produce proofs verified by the Private Kernel circuit
- **Public functions** execute in the AVM (Aztec Virtual Machine) on a proposer's machine

The aztec-nr framework provides abstractions that bridge user-facing contract code to the kernel-expected formats.

## Primary Kernel Interface: PrivateCircuitPublicInputs

The core interface between private functions and the Private Kernel circuit is `PrivateCircuitPublicInputs`. Every private function must return this structure.

**Definition location**: `noir-protocol-circuits/crates/types/src/abis/private_circuit_public_inputs.nr`

```noir
pub struct PrivateCircuitPublicInputs {
    // Context
    pub call_context: CallContext,
    pub args_hash: Field,
    pub returns_hash: Field,
    pub anchor_block_header: BlockHeader,
    pub tx_context: TxContext,

    // Transaction Phase Control
    pub min_revertible_side_effect_counter: u32,
    pub is_fee_payer: bool,
    pub include_by_timestamp: u64,

    // Side Effect Counters
    pub start_side_effect_counter: u32,
    pub end_side_effect_counter: u32,

    // Validation Requests
    pub expected_non_revertible_side_effect_counter: u32,
    pub expected_revertible_side_effect_counter: u32,
    pub note_hash_read_requests: ClaimedLengthArray<...>,
    pub nullifier_read_requests: ClaimedLengthArray<...>,
    pub key_validation_requests_and_generators: ClaimedLengthArray<...>,

    // Call Requests
    pub private_call_requests: ClaimedLengthArray<PrivateCallRequest, ...>,
    pub public_call_requests: ClaimedLengthArray<Counted<PublicCallRequest>, ...>,
    pub public_teardown_call_request: PublicCallRequest,

    // Tx Effects (state changes)
    pub note_hashes: ClaimedLengthArray<Counted<NoteHash>, ...>,
    pub nullifiers: ClaimedLengthArray<Counted<Nullifier>, ...>,
    pub l2_to_l1_msgs: ClaimedLengthArray<Counted<L2ToL1Message>, ...>,
    pub private_logs: ClaimedLengthArray<Counted<PrivateLogData>, ...>,
    pub contract_class_logs_hashes: ClaimedLengthArray<Counted<LogHash>, ...>,
}
```

### How aztec-nr Builds This Structure

The `PrivateContext.finish()` method (at `aztec/src/context/private_context.nr:585-620`) constructs this structure by collecting all accumulated side effects:

```noir
pub fn finish(self) -> PrivateCircuitPublicInputs {
    PrivateCircuitPublicInputs {
        call_context: self.inputs.call_context,
        args_hash: self.args_hash,
        returns_hash: self.return_hash,
        // ... all other fields from accumulated state
    }
}
```

### Macro-Generated Function Signature

The `#[external("private")]` macro transforms user-defined functions to return `PrivateCircuitPublicInputs`.

**Location**: `aztec/src/macros/internals_functions_generation/external/private.nr`

A user writes:
```noir
#[external("private")]
fn my_function(self: &mut MyContract, arg: Field) -> Field {
    // function body
}
```

The macro generates:
```noir
fn __aztec_nr_internals__my_function(
    inputs: PrivateContextInputs,  // Added by macro
    arg: Field
) -> return_data PrivateCircuitPublicInputs {  // Return type changed
    // Context creation
    let mut context = PrivateContext::new(inputs, args_hash);

    // User's function body

    // Return serialization and hash
    self.context.set_return_hash(serialized_return);

    // Build kernel-compatible output
    self.context.finish()
}
```

## Input Interface: PrivateContextInputs

**Location**: `aztec/src/context/inputs/private_context_inputs.nr:11-16`

```noir
pub struct PrivateContextInputs {
    pub call_context: CallContext,        // Who called, contract address, selector
    pub anchor_block_header: BlockHeader, // Historic block state for reads
    pub tx_context: TxContext,            // Chain ID, version, gas settings
    pub start_side_effect_counter: u32,   // Counter for ordering effects
}
```

### Where Do PrivateContextInputs Actually Come From?

**Important clarification**: The kernel does NOT provide `PrivateContextInputs` to app circuits. Instead:

1. **The simulator (PXE) constructs these inputs** based on:
   - For initial call: The `TxRequest` (user's transaction intent) + block header from Aztec Node
   - For nested calls: Parent's context + derived call context

2. **The kernel validates** that the app circuit's outputs match expected values

This is a **validation model**, not a provisioning model.

### Initial/Entry Call Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client (User)                                                            │
│                                                                          │
│  Constructs TxRequest:                                                   │
│  - origin (contract address)                                             │
│  - function_data (selector, is_private)                                  │
│  - args_hash                                                             │
│  - tx_context (chain_id, version, gas_settings)                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PXE / Simulator (contract_function_simulator.ts:162-176)                │
│                                                                          │
│  Constructs PrivateExecutionOracle with:                                │
│  - callContext: CallContext(msgSender=MAX, contractAddress, selector)    │
│  - txContext: from TxRequest                                             │
│  - anchorBlockHeader: fetched from Aztec Node                            │
│  - sideEffectCounter: starts at 2 (0-1 reserved for protocol nullifier) │
│                                                                          │
│  getPrivateContextInputs() (line 126-127):                               │
│    new PrivateContextInputs(callContext, anchorBlockHeader,              │
│                             txContext, sideEffectCounter)                │
│                                                                          │
│  Serializes to initial witness, passes to ACVM                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ App Circuit (aztec-nr)                                                   │
│                                                                          │
│  Receives PrivateContextInputs as witness                                │
│  Executes user logic                                                     │
│  Returns PrivateCircuitPublicInputs containing:                          │
│  - call_context (copied from inputs)                                     │
│  - tx_context (copied from inputs)                                       │
│  - args_hash, returns_hash, side effects, etc.                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Private Kernel Init (private_call_data_validator.nr:116-141)            │
│                                                                          │
│  validate_against_tx_request():                                          │
│  - tx_request.origin == public_inputs.call_context.contract_address      │
│  - tx_request.function_data.selector == public_inputs.call_context.sel   │
│  - tx_request.args_hash == public_inputs.args_hash                       │
│  - tx_request.tx_context == public_inputs.tx_context                     │
│                                                                          │
│  The kernel verifies the simulator constructed inputs correctly!         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Nested Call Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Parent Circuit (aztec-nr)                                                │
│                                                                          │
│  1. Calls context.call_private_function_with_args_hash()                 │
│  2. Triggers privateCallPrivateFunction oracle                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PXE / Simulator (private_execution_oracle.ts:501-563)                   │
│                                                                          │
│  privateCallPrivateFunction():                                           │
│  - derivedTxContext = this.txContext.clone()                             │
│  - derivedCallContext = deriveCallContext():                             │
│      msg_sender = parent's contract address                              │
│      contract_address = target contract                                  │
│      function_selector = target function                                 │
│  - sideEffectCounter = passed from parent                                │
│                                                                          │
│  Creates NEW PrivateExecutionOracle with derived values                  │
│  Executes child circuit                                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Parent Circuit (continued)                                               │
│                                                                          │
│  3. Oracle returns (end_side_effect_counter, returns_hash)               │
│  4. Parent creates PrivateCallRequest:                                   │
│     - call_context (msg_sender=parent, contract_address=callee, etc.)    │
│     - args_hash                                                          │
│     - returns_hash                                                       │
│     - start_side_effect_counter, end_side_effect_counter                 │
│  5. Pushes to private_call_requests array                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Private Kernel Inner (private_call_data_validator.nr:146-198)           │
│                                                                         │
│  validate_against_previous_kernel():                                    │
│  - anchor_block_header matches constants                                │
│  - tx_context matches constants                                         │
│                                                                         │
│  validate_against_call_request():                                       │
│  - request.call_context == child.call_context                           │
│  - request.args_hash == child.args_hash                                 │
│  - request.returns_hash == child.returns_hash                           │
│  - request.start_side_effect_counter == child.start_side_effect_counter │
│  - request.end_side_effect_counter == child.end_side_effect_counter     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Summary: Who Provides What

| Data                        | Source                                   | Validated By                                        |
| --------------------------- | ---------------------------------------- | --------------------------------------------------- |
| `call_context` (initial)    | Simulator constructs from TxRequest      | Kernel Init vs TxRequest                            |
| `call_context` (nested)     | Simulator derives from parent context    | Kernel Inner vs PrivateCallRequest                  |
| `tx_context`                | From TxRequest, passed through all calls | Kernel Init vs TxRequest, Kernel Inner vs constants |
| `anchor_block_header`       | Fetched from Aztec Node by simulator     | Kernel Inner vs constants                           |
| `start_side_effect_counter` | Simulator tracks and assigns             | Kernel vs call request                              |
| `args_hash`                 | Computed by simulator                    | Kernel vs TxRequest/call request                    |

## Oracle Interfaces

Oracles are the mechanism by which aztec-nr communicates with the execution environment (simulator). They serve two purposes:
1. **Notification oracles**: Inform the simulator of side effects for hint preparation
2. **Query oracles**: Retrieve data needed for execution

### Private Function Call Oracle

**Location**: `aztec/src/oracle/call_private_function.nr:5-12`

```noir
#[oracle(privateCallPrivateFunction)]
unconstrained fn call_private_function_oracle(
    _contract_address: AztecAddress,
    _function_selector: FunctionSelector,
    _args_hash: Field,
    _start_side_effect_counter: u32,
    _is_static_call: bool,
) -> [Field; 2] {}  // Returns [end_side_effect_counter, returns_hash]
```

**Origination**: Called from `PrivateContext.call_private_function_with_args_hash()` at line 1390:
```noir
let (end_side_effect_counter, returns_hash) = unsafe {
    call_private_function_internal(
        contract_address,
        function_selector,
        args_hash,
        start_side_effect_counter,
        is_static_call,
    )
};
```

After the oracle returns, the context records a `PrivateCallRequest` which the kernel will verify.

### Public Function Enqueue Oracles

**Location**: `aztec/src/oracle/enqueue_public_function_call.nr`

| Oracle                                           | Purpose                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| `privateNotifyEnqueuedPublicFunctionCall`        | Notifies that a public call has been enqueued        |
| `privateNotifySetPublicTeardownFunctionCall`     | Notifies that a teardown function has been set       |
| `privateNotifySetMinRevertibleSideEffectCounter` | Marks the transition between setup/revertible phases |
| `privateIsSideEffectCounterRevertible`           | Queries whether a counter is in the revertible phase |

**Origination**: Called from `PrivateContext.call_public_function_with_calldata_hash()` at line 1594:
```noir
notify_enqueued_public_function_call(
    contract_address,
    calldata_hash,
    counter,
    is_static_call,
);
```

### Note Management Oracles

**Location**: `aztec/src/oracle/notes.nr`

| Oracle                          | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `privateNotifyCreatedNote`      | Notifies simulator of new note creation  |
| `privateNotifyNullifiedNote`    | Notifies simulator of note nullification |
| `privateNotifyCreatedNullifier` | Notifies simulator of nullifier creation |
| `utilityGetNotes`               | Retrieves notes matching criteria        |
| `utilityCheckNullifierExists`   | Checks if nullifier exists               |

### Key Validation Oracle

**Location**: `aztec/src/oracle/key_validation_request.nr`

```noir
#[oracle(utilityGetKeyValidationRequest)]
```

Used to obtain key validation requests that the kernel will verify.

### Complete Oracle List

All oracles that interface with the kernel/simulator:

**Private execution oracles** (prefix: `private`):
- `privateCallPrivateFunction` - Execute nested private call
- `privateNotifyEnqueuedPublicFunctionCall` - Enqueue public call
- `privateNotifySetPublicTeardownFunctionCall` - Set teardown
- `privateNotifySetMinRevertibleSideEffectCounter` - Mark phase transition
- `privateIsSideEffectCounterRevertible` - Query phase
- `privateNotifyCreatedNote` - Note creation
- `privateNotifyNullifiedNote` - Note nullification
- `privateNotifyCreatedNullifier` - Nullifier creation
- `privateNotifyCreatedContractClassLog` - Contract class log
- `privateStoreInExecutionCache` - Store value in cache
- `privateLoadFromExecutionCache` - Load value from cache
- `privateGetNextAppTagAsSender` - Get next app tag
- `privateGetSenderForTags` - Get sender for tags
- `privateSetSenderForTags` - Set sender for tags

**Utility oracles** (prefix: `utility`):
- `utilityGetNotes` - Retrieve notes
- `utilityCheckNullifierExists` - Check nullifier
- `utilityGetKeyValidationRequest` - Key validation
- `utilityGetContractInstance` - Get contract instance
- `utilityGetBlockHeader` - Get block header
- `utilityGetMembershipWitness` - Get membership proof
- `utilityGetL1ToL2MembershipWitness` - L1→L2 message proof
- `utilityGetLowNullifierMembershipWitness` - Nullifier proof
- `utilityGetNullifierMembershipWitness` - Nullifier proof
- `utilityGetPublicDataWitness` - Public data proof
- `utilityStoreCapsule` / `utilityLoadCapsule` / `utilityDeleteCapsule` / `utilityCopyCapsule` - Capsule management
- `utilityGetPublicKeysAndPartialAddress` - Get public keys
- `utilityGetSharedSecret` - Get shared secret
- `utilityGetRandomField` - Get random field
- `utilityGetUtilityContext` - Get utility context
- `utilityEmitOffchainEffect` - Emit offchain effect
- `utilityFetchTaggedLogs` - Fetch tagged logs
- `utilityValidateEnqueuedNotesAndEvents` - Validate notes/events
- `utilityBulkRetrieveLogs` - Bulk log retrieval
- `utilityStorageRead` - Read storage
- `utilityGetAuthWitness` - Get auth witness
- `utilityAes128Decrypt` - AES decryption
- `utilityAssertCompatibleOracleVersion` - Version check

## Call Flow Diagram

### Private → Private Call

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Caller Private Function                                                  │
│                                                                          │
│  1. context.call_private_function_with_args_hash(...)                   │
│         │                                                                │
│         ▼                                                                │
│  2. call_private_function_oracle(...)  ←── Oracle call to simulator    │
│         │                                                                │
│         ▼                                                                │
│  3. Returns (end_side_effect_counter, returns_hash)                     │
│         │                                                                │
│         ▼                                                                │
│  4. Push PrivateCallRequest to private_call_requests                    │
│         │                                                                │
│         ▼                                                                │
│  5. context.finish() includes call request in PrivateCircuitPublicInputs│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Private Kernel Circuit                                                   │
│                                                                          │
│  - Verifies caller's PrivateCircuitPublicInputs                         │
│  - Verifies callee's PrivateCircuitPublicInputs                         │
│  - Validates PrivateCallRequest matches callee's call_context           │
│  - Validates side effect counter ordering                                │
│  - Validates returns_hash matches callee's returns_hash                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Private → Public Call (Enqueue)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Private Function                                                         │
│                                                                          │
│  1. context.call_public_function(contract, selector, args, hide_sender) │
│         │                                                                │
│         ▼                                                                │
│  2. Hash calldata → calldata_hash                                       │
│         │                                                                │
│         ▼                                                                │
│  3. execution_cache::store(calldata, calldata_hash)                     │
│         │                                                                │
│         ▼                                                                │
│  4. notify_enqueued_public_function_call(...)  ←── Notify simulator     │
│         │                                                                │
│         ▼                                                                │
│  5. Push PublicCallRequest to public_call_requests                      │
│         │                                                                │
│         ▼                                                                │
│  6. context.finish() includes in PrivateCircuitPublicInputs             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Private Kernel Circuit                                                   │
│                                                                          │
│  - Collects all PublicCallRequest entries                               │
│  - Orders them by side_effect_counter                                   │
│  - Passes to Public Kernel / AVM for execution                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ AVM (Aztec Virtual Machine)                                              │
│                                                                          │
│  - Retrieves calldata via calldata_hash from execution cache            │
│  - Executes public function                                              │
│  - Can modify public state, emit logs, etc.                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Public Function Interface: AVM Opcodes

Public functions run in the AVM and interface via opcodes rather than kernel structures.

**Location**: `aztec/src/context/public_context.nr:943-1051`

### AVM Opcodes Used

| Category             | Opcode                                           | Purpose                      |
| -------------------- | ------------------------------------------------ | ---------------------------- |
| **Context**          | `avmOpcodeAddress`                               | Get current contract address |
|                      | `avmOpcodeSender`                                | Get msg.sender               |
|                      | `avmOpcodeTransactionFee`                        | Get transaction fee          |
|                      | `avmOpcodeChainId`                               | Get chain ID                 |
|                      | `avmOpcodeVersion`                               | Get protocol version         |
|                      | `avmOpcodeBlockNumber`                           | Get block number             |
|                      | `avmOpcodeTimestamp`                             | Get block timestamp          |
|                      | `avmOpcodeMinFeePerL2Gas`                        | Get L2 gas price             |
|                      | `avmOpcodeMinFeePerDaGas`                        | Get DA gas price             |
|                      | `avmOpcodeL2GasLeft`                             | Get remaining L2 gas         |
|                      | `avmOpcodeDaGasLeft`                             | Get remaining DA gas         |
|                      | `avmOpcodeIsStaticCall`                          | Check if static call         |
| **Storage**          | `avmOpcodeStorageRead`                           | Read public storage          |
|                      | `avmOpcodeStorageWrite`                          | Write public storage         |
| **Notes/Nullifiers** | `avmOpcodeNoteHashExists`                        | Check note hash exists       |
|                      | `avmOpcodeEmitNoteHash`                          | Emit note hash               |
|                      | `avmOpcodeNullifierExists`                       | Check nullifier exists       |
|                      | `avmOpcodeEmitNullifier`                         | Emit nullifier               |
| **Logs/Messages**    | `avmOpcodeEmitUnencryptedLog`                    | Emit public log              |
|                      | `avmOpcodeL1ToL2MsgExists`                       | Check L1→L2 message          |
|                      | `avmOpcodeSendL2ToL1Msg`                         | Send L2→L1 message           |
| **Calls**            | `avmOpcodeCall`                                  | Call another public function |
|                      | `avmOpcodeStaticCall`                            | Static call (read-only)      |
|                      | `avmOpcodeSuccessCopy`                           | Check call success           |
|                      | `avmOpcodeCalldataCopy`                          | Copy calldata                |
|                      | `avmOpcodeReturndataSize`                        | Get returndata size          |
|                      | `avmOpcodeReturndataCopy`                        | Copy returndata              |
|                      | `avmOpcodeReturn`                                | Return from function         |
|                      | `avmOpcodeRevert`                                | Revert execution             |
| **Contract**         | `avmOpcodeGetContractInstanceDeployer`           | Get deployer                 |
|                      | `avmOpcodeGetContractInstanceClassId`            | Get class ID                 |
|                      | `avmOpcodeGetContractInstanceInitializationHash` | Get init hash                |

## Return Value Handling

Return values are not passed directly to kernels. Instead:

1. Private function serializes return values
2. Computes `returns_hash = hash_args(serialized_return)`
3. Stores preimage in execution cache via `privateStoreInExecutionCache`
4. Kernel only sees the hash in `PrivateCircuitPublicInputs.returns_hash`
5. Caller retrieves via `ReturnsHash.get_preimage()`

**Location**: `aztec/src/context/returns_hash.nr`

This reduces proof size and verification overhead.

## Side Effect Counter

The side effect counter is the ordering mechanism for all state-changing operations. Each side effect (note hash, nullifier, log, call) is assigned a sequential counter value.

**Key properties**:
- `start_side_effect_counter`: Counter when function began
- `end_side_effect_counter`: Counter when function ended
- All side effects must have counters within this range
- Nested calls consume counter ranges
- The kernel validates counter ordering

**Usage in PrivateContext**:
```noir
pub fn next_counter(&mut self) -> u32 {
    let counter = self.side_effect_counter;
    self.side_effect_counter += 1;
    counter
}
```

## Transaction Phases

Private execution supports three phases: setup, app logic, teardown.

**Phase boundary**:
```noir
// Set min_revertible_side_effect_counter to mark where setup ends
pub fn end_setup(&mut self) {
    let counter = self.next_counter();
    self.min_revertible_side_effect_counter = counter;
    notify_set_min_revertible_side_effect_counter(counter);
}
```

**Phase checking**:
```noir
pub fn in_revertible_phase(&self) -> bool {
    unsafe { is_side_effect_counter_revertible_oracle_wrapper(self.side_effect_counter) }
}
```

## Key Files Reference

### Aztec-nr (Contract Framework)

| File                                                                  | Purpose                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `aztec/src/context/private_context.nr`                                | Main private context implementation (~1800 lines) |
| `aztec/src/context/public_context.nr`                                 | Public context with AVM opcodes (~1050 lines)     |
| `aztec/src/context/inputs/private_context_inputs.nr`                  | Input structure definition                        |
| `aztec/src/oracle/call_private_function.nr`                           | Private call oracle                               |
| `aztec/src/oracle/enqueue_public_function_call.nr`                    | Public enqueue oracles                            |
| `aztec/src/oracle/notes.nr`                                           | Note management oracles                           |
| `aztec/src/macros/internals_functions_generation/external/private.nr` | Macro generating kernel-compatible signatures     |

### Protocol Circuits (Kernel)

| File                                                                                             | Purpose                    |
| ------------------------------------------------------------------------------------------------ | -------------------------- |
| `noir-protocol-circuits/crates/types/src/abis/private_circuit_public_inputs.nr`                  | Kernel interface structure |
| `noir-protocol-circuits/crates/private-kernel-lib/src/components/private_call_data_validator.nr` | Kernel validation logic    |

### Simulator (PXE/TypeScript)

| File                                                                                  | Purpose                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `yarn-project/pxe/src/contract_function_simulator/oracle/private_execution_oracle.ts` | Constructs PrivateContextInputs, handles oracles |
| `yarn-project/pxe/src/contract_function_simulator/oracle/private_execution.ts`        | Executes private functions via ACVM              |
| `yarn-project/pxe/src/contract_function_simulator/contract_function_simulator.ts`     | Entry point for simulation                       |
| `yarn-project/stdlib/src/kernel/private_context_inputs.ts`                            | TypeScript PrivateContextInputs class            |

## Summary

The boundary between aztec-nr and the kernels consists of:

1. **PrivateCircuitPublicInputs**: The structured output every private function returns, validated by the Private Kernel

2. **PrivateContextInputs**: Execution context constructed by the **simulator (PXE)** based on:
   - For entry point: `TxRequest` data + block header from Aztec Node
   - For nested calls: Parent's context + derived call context

   **Note**: The kernel does NOT provide these inputs; it validates that the app circuit's outputs are consistent with expected values (TxRequest for entry point, PrivateCallRequest for nested calls)

3. **Oracle calls**: Communication channel between aztec-nr and the simulator for:
   - Nested private calls (simulator creates new execution context)
   - Enqueuing public calls
   - Note/nullifier notifications
   - State queries

4. **AVM opcodes**: Direct interface for public functions running in the virtual machine

5. **Side effect counters**: Ordering mechanism validated by kernels to ensure deterministic execution

6. **Validation model**: The kernel acts as a verifier, not a provider:
   - Kernel Init validates app output against `TxRequest`
   - Kernel Inner validates child output against parent's `PrivateCallRequest`

The aztec-nr framework abstracts these interfaces behind developer-friendly APIs like `context.call_private_function()` and `context.call_public_function()`, while the macros transform user code into kernel-compatible circuits.
