# Compilation Targets: ACIR, Brillig, and AVM Bytecode

This document explains the three compilation targets used by Aztec smart contracts, why each exists, how compilation happens, and how the outputs flow through the system.

## Table of Contents

1. [Overview](#overview)
2. [The Three Compilation Targets](#the-three-compilation-targets)
3. [ACIR: Abstract Circuit Intermediate Representation](#acir-abstract-circuit-intermediate-representation)
4. [Brillig: Unconstrained Execution VM](#brillig-unconstrained-execution-vm)
5. [AVM Bytecode: Public Execution](#avm-bytecode-public-execution)
6. [The Compilation Pipeline](#the-compilation-pipeline)
7. [Runtime Execution Flow](#runtime-execution-flow)
8. [Execution Environments](#execution-environments)
9. [Why Three Formats?](#why-three-formats)
10. [Debugging and Tooling](#debugging-and-tooling)

---

## Overview

Aztec smart contracts compile to three different formats depending on the function type:

| Function Type | Annotation | Compilation Target | Execution Location |
|--------------|------------|-------------------|-------------------|
| Private | `#[external("private")]` | ACIR | Client (PXE) |
| Public | `#[external("public")]` | Brillig → AVM Bytecode | Sequencer (AVM) |
| Utility | `#[external("utility")]` | Brillig | Client (PXE) |

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Noir Source Code                              │
│                    (Aztec Smart Contract)                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ nargo compile
                                ▼
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│     ACIR      │     │    Brillig    │     │    Brillig    │
│  (Private)    │     │   (Utility)   │     │   (Public)    │
└───────────────┘     └───────────────┘     └───────────────┘
        │                       │                       │
        │                       │                       │ avm-transpiler
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│     ACVM      │     │  Brillig VM   │     │ AVM Bytecode  │
│  + Proving    │     │  (in PXE)     │     │ (Sequencer)   │
└───────────────┘     └───────────────┘     └───────────────┘
```

---

## The Three Compilation Targets

### Why Three Different Formats?

The fundamental reason is that **different execution environments have different requirements**:

1. **Private functions** need to generate ZK proofs → require constraint-based representation (ACIR)
2. **Utility functions** run unconstrained on user devices → need efficient VM execution (Brillig)
3. **Public functions** run on sequencers and must support reverts → need blockchain VM (AVM)

Each format is optimized for its execution environment's specific needs.

---

## ACIR: Abstract Circuit Intermediate Representation

**Location:** `noir/noir-repo/acvm-repo/acir/`

### What is ACIR?

ACIR is a **constraint-based representation** designed for zero-knowledge proving systems. It represents computation as a system of constraints that must be satisfied, rather than as a sequence of operations.

### Key Characteristics

- **Constraint model**: Instead of "execute these operations", ACIR says "find values that satisfy these constraints"
- **Deterministic execution order**: Constraints are ordered so they can be solved sequentially
- **Backend-agnostic**: Works with any proving system (Barretenberg, etc.)
- **Supports blackbox functions**: Cryptographic operations (Poseidon, SHA256, etc.) have optimized implementations

### ACIR Structure

```
┌────────────────────────────────────────────────────────────────┐
│                         ACIR Program                            │
├────────────────────────────────────────────────────────────────┤
│ Witnesses: w0, w1, w2, ... (values to be determined)           │
│                                                                 │
│ Constraints (Opcodes):                                          │
│   • AssertZero: w0 - (w1 + w2) = 0                             │
│   • BlackBoxFuncCall: Poseidon2(w3, w4) -> w5                  │
│   • BrilligCall: call unconstrained function                    │
│   • MemoryOp: load/store to memory                              │
└────────────────────────────────────────────────────────────────┘
```

### ACIR Opcodes

The main opcode types are:

| Opcode | Purpose |
|--------|---------|
| `AssertZero` | Assert an expression equals zero (the fundamental constraint) |
| `BlackBoxFuncCall` | Call optimized cryptographic functions |
| `BrilligCall` | Call unconstrained Brillig code for witness generation |
| `MemoryOp` | Load/store operations on memory |

### Workflow

```
1. User provides inputs (witnesses)
2. ACVM executes/solves constraints to find all witness values
3. Complete witness assignment + ACIR → Proving system
4. Proving system generates ZK proof
```

### Why ACIR for Private Functions?

Private functions must:
- Generate ZK proofs of correct execution
- Hide computation details from observers
- Produce outputs (note hashes, nullifiers) that can be verified

ACIR's constraint model naturally maps to the arithmetic circuits used by ZK proving systems. The proving backend (Barretenberg) converts ACIR to its native constraint format and generates proofs.

---

## Brillig: Unconstrained Execution VM

**Location:** `noir/noir-repo/acvm-repo/brillig/`

### What is Brillig?

Brillig is a **general-purpose virtual machine** designed for unconstrained (non-ZK) execution within a circuit language context. The name comes from "Jabberwocky" by Lewis Carroll and distinguishes constrained (ACIR) from unconstrained (Brillig) execution.

### Key Characteristics

- **Imperative execution**: Traditional program counter-based VM
- **Finite field arithmetic**: Operates over the same field as ACIR
- **Memory-based**: Uses a flat memory array of field elements
- **Foreign calls**: Can invoke external functions (oracles)
- **No proof generation**: Execution is trusted, not proven

### Brillig Opcodes

```rust
enum BrilligOpcode {
    // Arithmetic
    BinaryFieldOp { op: Add|Sub|Mul|Div, lhs, rhs, destination },
    BinaryIntOp { op: Add|Sub|And|Or|Shl|Shr|..., lhs, rhs, destination, bit_size },

    // Control flow
    Jump { location },
    JumpIf { condition, location },
    JumpIfNot { condition, location },
    Call { location },
    Return,

    // Memory
    Const { destination, value },
    Load { destination, source_pointer },
    Store { destination_pointer, source },

    // External interaction
    ForeignCall { function, inputs, outputs },
    BlackBox { op },  // Cryptographic operations

    // Termination
    Stop,
    Trap,  // Error/assertion failure
}
```

### Example Brillig Code

For the Noir code:
```noir
let c = a + b;
if c <= 15 { a = a * b; } else { b = a + b; }
```

The Brillig output is:
```json
[
    { "Const": { "destination": 0, "value": "10" } },    // a = 10
    { "Const": { "destination": 1, "value": "5" } },     // b = 5
    { "BinaryIntOp": { "op": "Add", "lhs": 0, "rhs": 1, "destination": 2 } },  // c = a + b
    { "BinaryIntOp": { "op": "LessThanEquals", "lhs": 2, "rhs": 3, "destination": 4 } },
    { "JumpIf": { "condition": 4, "location": 7 } },
    { "BinaryFieldOp": { "op": "Add", ... } },          // else branch
    { "Jump": { "location": 8 } },
    { "BinaryFieldOp": { "op": "Multiply", ... } },     // if branch
    { "Stop": {} }
]
```

### Why Brillig for Utility Functions?

Utility functions (`#[external("utility")]`) need to:
- Query private notes from the user's PXE
- Perform complex computations without constraint costs
- Return data to SDKs/applications

Generating ZK proofs for these operations would be:
- Expensive (proof generation takes time)
- Unnecessary (the user trusts their own device)
- Limiting (can't query external data in circuits)

Brillig provides efficient execution without the overhead of proving.

### Brillig in ACIR

ACIR can embed Brillig calls via the `BrilligCall` opcode:

```
ACIR Program:
  [0] BrilligCall(brillig_bytecode, inputs) -> outputs
  [1] AssertZero(constraint_on_outputs)
```

This pattern allows:
1. Unconstrained computation to find values (Brillig)
2. Constrained verification that values are correct (ACIR)

For example, computing the inverse of a field element:
- **Brillig**: Compute `1/x` using unconstrained division
- **ACIR**: Assert `x * (1/x) = 1`

---

## AVM Bytecode: Public Execution

**Location:** `avm-transpiler/`

### What is AVM?

The AVM (Aztec Virtual Machine) is a **zkVM designed for public function execution**. It's similar in concept to the EVM but:
- Operates over finite fields
- Designed for efficient ZK proving
- Includes Aztec-specific opcodes

### Why Transpile from Brillig?

Public functions are initially compiled to Brillig (because they're `unconstrained` in Noir), then **transpiled** to AVM bytecode. This design:
- Leverages Noir's existing compilation infrastructure
- Allows the AVM to be Aztec-specific without modifying Noir
- Separates concerns between language compilation and blockchain execution

### Transpilation Process

```
Noir public function
        │
        │ nargo compile
        ▼
   Brillig bytecode
        │
        │ avm-transpiler
        ▼
   AVM bytecode
```

The transpiler (`avm-transpiler/src/transpile.rs`) performs a 1:1 mapping of Brillig opcodes to AVM opcodes:

```rust
// From transpile.rs
match brillig_instr {
    BrilligOpcode::BinaryFieldOp { op: BinaryFieldOp::Add, .. } => {
        AvmOpcode::ADD_8 or ADD_16
    }
    BrilligOpcode::BinaryIntOp { op: BinaryIntOp::And, .. } => {
        AvmOpcode::AND_8 or AND_16
    }
    // ... etc
}
```

### AVM Opcodes

The AVM has opcodes organized into categories:

**Compute:**
```
ADD_8, ADD_16, SUB_8, SUB_16, MUL_8, MUL_16, DIV_8, DIV_16
EQ_8, EQ_16, LT_8, LT_16, LTE_8, LTE_16
AND_8, AND_16, OR_8, OR_16, XOR_8, XOR_16, NOT_8, NOT_16
SHL_8, SHL_16, SHR_8, SHR_16
CAST_8, CAST_16
```

**Execution Environment:**
```
GETENVVAR_16    - Get environment variables (address, sender, etc.)
CALLDATACOPY    - Copy calldata to memory
RETURNDATASIZE  - Get return data size
RETURNDATACOPY  - Copy return data to memory
```

**Control Flow:**
```
JUMP_32, JUMPI_32      - Unconditional/conditional jumps
INTERNALCALL           - Call within the same contract
INTERNALRETURN         - Return from internal call
```

**Memory:**
```
SET_8, SET_16, SET_32, SET_64, SET_128, SET_FF  - Set memory values
MOV_8, MOV_16                                    - Move between memory locations
```

**World State (Aztec-specific):**
```
SLOAD, SSTORE              - Public storage read/write
NOTEHASHEXISTS             - Check if note hash exists
EMITNOTEHASH               - Emit a note hash
NULLIFIEREXISTS            - Check if nullifier exists
EMITNULLIFIER              - Emit a nullifier
L1TOL2MSGEXISTS            - Check L1→L2 message existence
GETCONTRACTINSTANCE        - Get contract instance data
EMITUNENCRYPTEDLOG         - Emit public log
SENDL2TOL1MSG              - Send L2→L1 message
```

**External Calls:**
```
CALL, STATICCALL           - Call other contracts
RETURN                     - Return successfully
REVERT_8, REVERT_16        - Revert execution
```

**Gadgets (Cryptographic):**
```
POSEIDON2, SHA256COMPRESSION, KECCAKF1600, ECADD, TORADIXBE
```

### Why AVM for Public Functions?

Public functions must:
- Execute on the sequencer (not user device)
- Support **reverts** (unlike private functions)
- Be **provable** (sequencer generates proof of execution)
- Access **current state** (not historical)

The AVM provides:
1. **Revert support**: The `REVERT` opcode allows functions to fail gracefully
2. **State access**: Direct opcodes for storage, notes, nullifiers
3. **Provability**: Designed for efficient zkVM proving (though currently simulated)
4. **Attribution**: Can distinguish user errors from prover misbehavior

---

## The Compilation Pipeline

### Step-by-Step Process

```
┌─────────────────────────────────────────────────────────────────────┐
│                    1. COMPILE (nargo compile)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Noir Source (.nr) ──► Frontend ──► SSA ──► ACIR/Brillig            │
│                                                                      │
│  For each function:                                                  │
│  • Private → ACIR bytecode                                          │
│  • Public → Brillig bytecode                                        │
│  • Utility → Brillig bytecode                                       │
│                                                                      │
│  Output: contract-Name.json with all function bytecodes              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 2. TRANSPILE (avm-transpiler)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  For public functions only:                                          │
│  • Read Brillig bytecode from JSON                                   │
│  • Convert each Brillig opcode → AVM opcode(s)                       │
│  • Handle special cases (foreign calls → Aztec opcodes)              │
│  • Write AVM bytecode back to JSON                                   │
│                                                                      │
│  Output: contract-Name.json with bytecode field updated              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│              3. VERIFICATION KEY GENERATION (bb)                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  For private functions only:                                         │
│  • Read ACIR bytecode                                                │
│  • Generate verification key using Barretenberg                      │
│  • Add base64-encoded VK to function JSON                            │
│                                                                      │
│  Output: contract-Name.json with verification_key fields             │
└─────────────────────────────────────────────────────────────────────┘
```

### Bootstrap Script

The `noir-projects/noir-contracts/bootstrap.sh` orchestrates this pipeline:

```bash
# 1. Compile with nargo
$NARGO compile --package $contract --inliner-aggressiveness 0

# 2. Transpile public functions
$TRANSPILER $json_path $json_path

# 3. Generate VKs for private functions (in parallel)
for each function:
    if not public and not unconstrained:
        $BB write_vk --scheme chonk -b bytecode -o outdir
```

---

## Runtime Execution Flow

### Private Function Execution

```
┌──────────────────────────────────────────────────────────────────┐
│                        User's Device (PXE)                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Load ACIR bytecode from contract artifact                     │
│                                                                   │
│  2. ACVM Execution:                                               │
│     • Provide input witnesses (function args, context)            │
│     • Solve constraints to find all witness values                │
│     • Execute embedded Brillig (for unconstrained helpers)        │
│     • Call oracles for external data (notes, keys, etc.)          │
│                                                                   │
│  3. Proving:                                                      │
│     • Complete witness + ACIR → Barretenberg                      │
│     • Generate ZK proof of correct execution                      │
│                                                                   │
│  4. Output:                                                       │
│     • Proof                                                       │
│     • PrivateCircuitPublicInputs (note hashes, nullifiers, etc.)  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Utility Function Execution

```
┌──────────────────────────────────────────────────────────────────┐
│                        User's Device (PXE)                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Load Brillig bytecode from contract artifact                  │
│                                                                   │
│  2. Brillig VM Execution:                                         │
│     • Initialize with calldata                                    │
│     • Execute opcodes sequentially                                │
│     • Handle foreign calls (oracles for notes, storage, etc.)     │
│                                                                   │
│  3. Output:                                                       │
│     • Return value (no proof needed)                              │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Public Function Execution

```
┌──────────────────────────────────────────────────────────────────┐
│                          Sequencer (AVM)                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Receive enqueued public call from transaction                 │
│                                                                   │
│  2. Load AVM bytecode from deployed contract                      │
│                                                                   │
│  3. AVM Simulator Execution:                                      │
│     • Initialize machine state (memory, gas, call stack)          │
│     • Execute opcodes sequentially                                │
│     • Handle state access (SLOAD/SSTORE, notes, nullifiers)       │
│     • Process external calls (CALL, STATICCALL)                   │
│     • Track side effects for rollup                               │
│                                                                   │
│  4. Outcome:                                                      │
│     • Success: return data + state changes                        │
│     • Revert: error data + no state changes                       │
│                                                                   │
│  5. (Future) AVM Proving:                                         │
│     • Generate ZK proof of correct execution                      │
│     • Include in rollup proof                                     │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Execution Environments

### ACVM (Abstract Circuit Virtual Machine)

**Location:** `noir/noir-repo/acvm-repo/acvm/`

The ACVM:
- Solves ACIR constraints to compute witness values
- Executes embedded Brillig for unconstrained computations
- Provides foreign call interface for oracles
- Outputs complete witness assignment for proving

**Usage in Aztec:** `yarn-project/simulator/src/private/acvm/`

### Brillig VM

**Location:** `noir/noir-repo/acvm-repo/brillig_vm/`

The Brillig VM:
- Executes Brillig bytecode directly
- Provides memory, registers, and call stack
- Handles foreign calls to external systems
- Supports black box functions (crypto primitives)

**Usage in Aztec:** Called by ACVM when executing unconstrained code

### AVM Simulator

**Location:** `yarn-project/simulator/src/public/avm/`

The AVM Simulator:
- Executes AVM bytecode on the sequencer
- Manages machine state (memory, gas, program counter)
- Interfaces with world state (storage, notes, nullifiers)
- Tracks side effects for transaction processing
- Handles cross-contract calls

---

## Why Three Formats?

### The Trade-offs

| Aspect | ACIR | Brillig | AVM |
|--------|------|---------|-----|
| **Proof generation** | Yes (required) | No | Yes (future) |
| **Execution speed** | Slow (constraint solving) | Fast | Medium |
| **Revert support** | No | Yes (Trap) | Yes (REVERT) |
| **State access** | Historical only | Any (via oracles) | Current |
| **Execution location** | User device | User device | Sequencer |

### Why Not Just One Format?

**ACIR everywhere?**
- Proof generation is expensive
- Can't efficiently handle unconstrained operations
- No revert support

**Brillig everywhere?**
- Can't generate proofs
- Not designed for blockchain VM requirements
- Missing Aztec-specific opcodes

**AVM everywhere?**
- Overkill for client-side utility functions
- Not optimized for ZK proving of private functions
- Would require running sequencer infrastructure locally

### The Hybrid Approach

Aztec's approach combines the best of each:

1. **Private functions (ACIR)**: Must generate proofs, so constraint-based representation is essential
2. **Utility functions (Brillig)**: Run locally without proofs, so efficient VM is ideal
3. **Public functions (AVM)**: Run on sequencer with revert support and future proving capability

---

## Debugging and Tooling

### Viewing Compiled Output

```bash
# Compile a contract
nargo compile --package my_contract

# View the artifact
cat target/my_contract-MyContract.json | jq '.functions[0]'
```

### Viewing Brillig Bytecode

```bash
# Use nargo's --show-brillig flag
nargo compile --package my_contract --show-brillig
```

### Inspecting AVM Bytecode

After transpilation, the `bytecode` field in the JSON contains the AVM bytecode. The opcodes can be decoded using the serialization logic in `avm-transpiler/src/instructions.rs`.

### Expanding Macros

```bash
# See the code after macro expansion
nargo expand --package my_contract
```

This shows the actual Noir code that gets compiled, including all macro-generated functions.

### Testing Transpiler Changes

From `avm-transpiler/README.md`:

```bash
# 1. Compile a test contract
nargo compile --package avm_test_contract --inliner-aggressiveness=0

# 2. Transpile it
./scripts/transpile.sh

# 3. Run simulator tests
cd yarn-project/simulator
yarn test src/avm/avm_simulator.test.ts
```

---

## Summary

| Format | Purpose | Generated By | Consumed By | Key Characteristic |
|--------|---------|--------------|-------------|-------------------|
| ACIR | Private functions | nargo | ACVM + Barretenberg | Constraint-based, provable |
| Brillig | Unconstrained code | nargo | Brillig VM | Imperative, efficient |
| AVM | Public functions | avm-transpiler | AVM Simulator | Blockchain VM, revertible |

The three formats serve distinct purposes in Aztec's execution model:
- **ACIR** enables private, provable computation
- **Brillig** enables efficient unconstrained helpers
- **AVM** enables public, revertible blockchain execution

Understanding these formats is essential for:
- Debugging compilation issues
- Understanding execution behavior
- Optimizing contract performance
- Extending the compilation pipeline
