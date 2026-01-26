# The `#[aztec]` Macro: A Comprehensive Guide

This document provides a detailed explanation of the `#[aztec]` macro, which transforms a Noir `contract` module into a fully-featured Aztec smart contract. The macro performs extensive code generation to provide the infrastructure needed for private/public execution, cross-contract calls, storage management, and more.

## Table of Contents

1. [Overview](#overview)
2. [The `contract` Keyword](#the-contract-keyword)
3. [Macro Entry Point](#macro-entry-point)
4. [Step 1: Function Validation](#step-1-function-validation)
5. [Step 2: Function Processing](#step-2-function-processing)
6. [Step 3: Contract Interface Generation](#step-3-contract-interface-generation)
7. [Step 4: Self-Call Structs Generation](#step-4-self-call-structs-generation)
8. [Step 5: Internal Function Call Struct Generation](#step-5-internal-function-call-struct-generation)
9. [Step 6: ABI Export Generation](#step-6-abi-export-generation)
10. [Step 7: Note Hash and Nullifier Computation](#step-7-note-hash-and-nullifier-computation)
11. [Step 8: Public Dispatch Function Generation](#step-8-public-dispatch-function-generation)
12. [Step 9: Utility Functions Generation](#step-9-utility-functions-generation)
13. [Supporting Macros](#supporting-macros)
14. [The ContractSelf Struct](#the-contractself-struct)
15. [Complete Flow Diagram](#complete-flow-diagram)

---

## Overview

The `#[aztec]` macro is applied to a `contract` module and performs the following high-level transformations:

1. Validates that all functions have appropriate annotations
2. Generates new "internal" versions of functions prefixed with `__aztec_nr_internals__`
3. Makes original functions uncallable to prevent direct invocation
4. Creates a contract interface struct for cross-contract calls
5. Generates helper structs for self-calls (`CallSelf`, `EnqueueSelf`, etc.)
6. Creates ABI export structs for tooling integration
7. Generates the `public_dispatch` function for public function routing
8. Injects utility functions for note discovery and message processing

**Location:** `aztec/src/macros/aztec.nr`

---

## The `contract` Keyword

Before diving into the macro, it's important to understand that `contract` is a **Noir language keyword**, not something provided by Aztec.nr.

The `contract` keyword is defined in the Noir compiler's lexer (`noir-repo/compiler/noirc_frontend/src/lexer/token.rs`). Syntactically, it's similar to `mod` - both define modules. The key difference is that `contract` sets an `is_contract: bool` flag on the module.

**Effects of `is_contract = true`:**
- Functions in a contract module that aren't marked with `#[contract_library_method]` or `#[test]` are treated as entry points
- Entry point functions get compiled as separate circuits
- The `Module` type in comptime has an `is_contract()` method for macro introspection

---

## Macro Entry Point

**File:** `aztec/src/macros/aztec.nr:21-75`

```noir
pub comptime fn aztec(m: Module) -> Quoted {
    // Step 1: Validate all functions have required annotations
    check_each_fn_macroified(m);

    // Step 2: Process functions (generate __aztec_nr_internals__ versions)
    let functions = process_functions(m);

    // Step 3: Generate contract interface
    let interface = generate_contract_interface(m);

    // Step 4: Generate self-call structs
    let self_call_structs = generate_external_function_self_calls_structs(m);

    // Step 5: Generate internal function call struct
    let call_internal_struct = generate_call_internal_struct(m);

    // Step 6: Generate ABI exports
    let fn_abi_exports = create_fn_abi_exports(m);

    // Step 7: Generate note hash and nullifier computation (if notes exist)
    let contract_library_method_compute_note_hash_and_nullifier = ...;

    // Step 8: Generate public dispatch function
    let public_dispatch = generate_public_dispatch(m);

    // Step 9: Generate utility functions
    let sync_private_state_fn_and_abi_export = ...;
    let process_message_fn_and_abi_export = ...;

    // Return all generated code
    quote { ... }
}
```

---

## Step 1: Function Validation

**File:** `aztec/src/macros/aztec.nr:329-343`

**Why:** Contracts require all functions to be explicitly categorized. This prevents developers from accidentally exposing functions or creating ambiguous entry points.

**How:** The `check_each_fn_macroified` function iterates over all functions in the module and verifies each has one of:
- `#[external("private")]`, `#[external("public")]`, or `#[external("utility")]`
- `#[internal("private")]` or `#[internal("public")]`
- `#[contract_library_method]`
- `#[test]`

```noir
comptime fn check_each_fn_macroified(m: Module) {
    for f in m.functions() {
        let name = f.name();
        if !is_fn_external(f) & !is_fn_contract_library_method(f)
           & !is_fn_internal(f) & !is_fn_test(f) {
            panic(f"Function {name} must be marked as either #[external(...)], #[internal(...)], or #[test]");
        }
    }
}
```

---

## Step 2: Function Processing

**File:** `aztec/src/macros/internals_functions_generation/mod.nr:58-115`

**Why:** Aztec contracts need to:
1. Inject context setup code (storage initialization, `self` variable creation)
2. Add security checks (initialization, view, only_self, authwit)
3. Transform return types for kernel circuit compatibility
4. Prevent direct function calls within the contract

**How:** The `process_functions` function:

### 2.1 Categorize Functions

Functions are retrieved from registries populated by the `#[external(...)]` and `#[internal(...)]` macros:

```noir
let private_functions = external_functions_registry::get_private_functions(m);
let public_functions = external_functions_registry::get_public_functions(m);
let utility_functions = external_functions_registry::get_utility_functions(m);
let private_internal_functions = internal_functions_registry::get_private_functions(m);
let public_internal_functions = internal_functions_registry::get_public_functions(m);
```

### 2.2 Generate Transformed Functions

For each function, a new version is generated with the `__aztec_nr_internals__` prefix:

**Private External Functions** (`external/private.nr`):
- Add `PrivateContextInputs` parameter
- Serialize and hash function arguments
- Initialize `PrivateContext` with args hash
- Initialize storage (if contract has storage)
- Create `ContractSelf` instance with all call helpers
- Add checks: `only_self`, `view`, `initializer`, `authorize_once`, `noinitcheck`, `nophasecheck`
- Transform return value: serialize and set return hash
- Change return type to `PrivateCircuitPublicInputs`

**Public External Functions** (`external/public.nr`):
- Mark as `unconstrained` (compiles to AVM bytecode)
- Initialize `PublicContext`
- Initialize storage
- Create `ContractSelf` instance
- Add checks: `only_self`, `view`, `initializer`, `authorize_once`, `noinitcheck`

**Utility External Functions** (`external/utility.nr`):
- Mark as `unconstrained`
- Initialize `UtilityContext`
- Initialize storage
- Create `ContractSelf` instance (with limited capabilities)

**Internal Functions** (`internal.nr`):
- Similar to external but marked with `#[contract_library_method]`
- Receive context as a parameter (for inlining into calling function)

### 2.3 Make Original Functions Uncallable

Original functions are modified to prevent direct invocation:

```noir
comptime fn make_functions_uncallable<let N: u32>(
    functions: [FunctionDefinition],
    error_message_template: str<N>,
) {
    functions.for_each(|function| {
        // Replace body with static_assert(false, ...)
        let body = f"{{ std::static_assert(false, \"{error_message}\"); std::mem::zeroed() }}";
        function.set_body(body_expr);

        // Prefix params with "_" to suppress warnings
        // Add #[contract_library_method] to prevent entry point compilation
        function.add_attribute("contract_library_method");
    });
}
```

---

## Step 3: Contract Interface Generation

**File:** `aztec/src/macros/aztec.nr:77-139`

**Why:** Enable ergonomic cross-contract calls like `Token::at(address).transfer(amount)`.

**How:** The `generate_contract_interface` function creates:

### 3.1 Contract Interface Struct

```noir
pub struct Token {
    pub target_contract: AztecAddress
}
```

### 3.2 Interface Methods

For each external function, a method is generated that returns a call object:

```noir
impl Token {
    pub fn transfer(self, to: AztecAddress, amount: u128)
        -> PrivateCall</* name_len */, /* args_len */, /* return_type */>
    {
        // Serialize arguments
        let serialized_args = ...;
        let selector = FunctionSelector::from_field(/* computed_selector */);
        PrivateCall::new(self.target_contract, selector, "transfer", serialized_args)
    }

    pub fn at(addr: AztecAddress) -> Self {
        Self { target_contract: addr }
    }

    pub fn interface() -> Self {
        Self { target_contract: AztecAddress::zero() }
    }

    pub fn storage_layout() -> StorageLayoutFields { ... }
}
```

### 3.3 Function Selector Computation

**File:** `aztec/src/macros/utils.nr:118-134`

Selectors are computed from function signatures (name + parameter types):

```noir
pub(crate) comptime fn compute_fn_selector(f: FunctionDefinition) -> Field {
    let fn_name = f.name();
    let args_signatures = f.parameters().map(|(_, typ)| signature_of_type(typ)).join(quote {,});
    let signature_quote = quote { $fn_name($args_signatures) };
    // Hash signature to get selector
    FunctionSelector::from_signature(signature_str).to_field()
}
```

---

## Step 4: Self-Call Structs Generation

**File:** `aztec/src/macros/calls_generation/external_functions.nr:61-170`

**Why:** Enable convenient self-invocation patterns like `self.call_self.my_function(args)`.

**How:** The `generate_external_function_self_calls_structs` function creates four structs:

### 4.1 CallSelf

For calling the contract's own non-view functions:

```noir
pub struct CallSelf<Context> {
    pub address: AztecAddress,
    pub context: Context,
}

impl CallSelf<&mut PrivateContext> {
    pub fn transfer(self, to: AztecAddress, amount: u128) -> u128 {
        // Serialize args, compute selector, hash args
        // Store args in execution cache
        // Call private function with args hash
        self.context.call_private_function_with_args_hash(...)
    }
}

impl CallSelf<PublicContext> {
    pub fn transfer_public(self, ...) -> ... {
        PublicCall::new(...).call(self.context)
    }
}
```

### 4.2 CallSelfStatic

For calling view functions (static calls):

```noir
pub struct CallSelfStatic<Context> { ... }
// Similar to CallSelf but for #[view] functions
```

### 4.3 EnqueueSelf

For enqueuing public function calls from private context:

```noir
pub struct EnqueueSelf<Context> { ... }

impl EnqueueSelf<&mut PrivateContext> {
    pub fn update_balance(self, ...) {
        // Serialize args, compute selector
        // Hash calldata and store in execution cache
        self.context.call_public_function_with_calldata_hash(...)
    }
}
```

### 4.4 EnqueueSelfStatic

For enqueuing view public function calls from private context:

```noir
pub struct EnqueueSelfStatic<Context> { ... }
```

---

## Step 5: Internal Function Call Struct Generation

**File:** `aztec/src/macros/calls_generation/internal_functions.nr:59-83`

**Why:** Enable the `self.internal.my_internal_function(args)` API for calling internal functions.

**How:** The `generate_call_internal_struct` function creates:

```noir
pub struct CallInternal<Context> {
    pub context: Context,
}

impl CallInternal<&mut PrivateContext> {
    pub fn subtract_balance(self, account: AztecAddress, amount: u128) -> u128 {
        // Call the __aztec_nr_internals__ version
        __aztec_nr_internals__subtract_balance(self.context, account, amount)
    }
}

impl CallInternal<PublicContext> {
    pub unconstrained fn _finalize_transfer(self, ...) -> ... {
        __aztec_nr_internals___finalize_transfer(self.context, ...)
    }
}
```

---

## Step 6: ABI Export Generation

**File:** `aztec/src/macros/internals_functions_generation/abi_export.nr`

**Why:** Preserve original function signatures for tooling. After macro transformations, return types change (e.g., to `PrivateCircuitPublicInputs`), but external tools need the original signatures.

**How:** The `create_fn_abi_export` function generates two structs per function:

```noir
// For: fn increment(owner: AztecAddress) -> Field

pub struct increment_parameters {
    pub owner: AztecAddress
}

#[abi(functions)]
pub struct increment_abi {
    parameters: increment_parameters,
    return_type: Field
}
```

The `#[abi(functions)]` attribute marks the struct for inclusion in the contract artifact's `outputs.functions` array.

---

## Step 7: Note Hash and Nullifier Computation

**File:** `aztec/src/macros/aztec.nr:144-277`

**Why:** Enable note discovery and processing. The generated function matches note type IDs to their respective types and computes note hashes and nullifiers.

**How:** The `generate_contract_library_method_compute_note_hash_and_nullifier` function:

### 7.1 For Contracts With Notes

Generates an if-else chain matching `note_type_id` to each registered note type:

```noir
#[contract_library_method]
unconstrained fn _compute_note_hash_and_nullifier(
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    owner: AztecAddress,
    storage_slot: Field,
    note_type_id: Field,
    contract_address: AztecAddress,
    randomness: Field,
    note_nonce: Field,
) -> Option<NoteHashAndNullifier> {
    if note_type_id == TokenNote::get_id() {
        let note = TokenNote::unpack(packed_note.storage());
        let note_hash = note.compute_note_hash(owner, storage_slot, randomness);
        let inner_nullifier = note.compute_nullifier_unconstrained(owner, note_hash_for_nullification);
        Option::some(NoteHashAndNullifier { note_hash, inner_nullifier })
    } else if note_type_id == AnotherNote::get_id() {
        // ...
    } else {
        Option::none()
    }
}
```

### 7.2 For Contracts Without Notes

Generates a function that immediately panics:

```noir
#[contract_library_method]
unconstrained fn _compute_note_hash_and_nullifier(...) -> Option<NoteHashAndNullifier> {
    panic(f"This contract does not use private notes")
}
```

---

## Step 8: Public Dispatch Function Generation

**File:** `aztec/src/macros/dispatch.nr`

**Why:** Route incoming public function calls to the correct function based on the selector. Public functions are transpiled to AVM bytecode and need a single entry point.

**How:** The `generate_public_dispatch` function:

### 8.1 Collect All Public Functions

```noir
let functions = get_public_functions(m);
```

### 8.2 Detect Selector Collisions

```noir
if seen_selectors.contains_key(selector) {
    panic(f"Public function selector collision detected between functions '{fn_name}' and '{existing_fn}'");
}
```

### 8.3 Generate Dispatch Logic

```noir
#[abi_public]
pub unconstrained fn public_dispatch(selector: Field) {
    if selector == /* transfer_selector */ {
        let input_calldata: [Field; N] = calldata_copy(1, N);
        let mut reader = Reader::new(input_calldata);
        let arg0: AztecAddress = reader.read_struct(Deserialize::deserialize);
        let arg1: u128 = reader.read_struct(Deserialize::deserialize);

        let return_value = __aztec_nr_internals__transfer(arg0, arg1);
        avm_return(Serialize::serialize(return_value).as_vector());
    }
    if selector == /* another_selector */ {
        // ...
    }
    panic(f"Unknown selector {selector}")
}
```

---

## Step 9: Utility Functions Generation

**File:** `aztec/src/macros/aztec.nr:279-325`

**Why:** Provide standard functionality for note discovery and message processing.

### 9.1 sync_private_state

```noir
#[abi_utility]
unconstrained fn sync_private_state() {
    let address = UtilityContext::new().this_address();
    discover_new_messages(address, _compute_note_hash_and_nullifier);
}
```

### 9.2 process_message

```noir
#[abi_utility]
unconstrained fn process_message(
    message_ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    message_context: MessageContext,
) {
    let address = UtilityContext::new().this_address();
    discover_new_messages(address, _compute_note_hash_and_nullifier);
    process_message_ciphertext(address, _compute_note_hash_and_nullifier, message_ciphertext, message_context);
}
```

---

## Supporting Macros

### #[storage]

**File:** `aztec/src/macros/storage.nr`

**Why:** Define contract storage layout and generate initialization code.

**How:**
1. Validates the struct is named `Storage`
2. For each field, computes storage slot based on `StateVariable::N` (storage size)
3. Generates `Storage::init(context)` constructor
4. Creates `StorageLayout` struct with slot information for tooling

```noir
impl<Context> Storage<Context> {
    fn init(context: Context) -> Self {
        Self {
            admin: StateVariable::<1, Context>::new(context, 1),
            balances: StateVariable::<2, Context>::new(context, 2),
            // ...
        }
    }
}

#[abi(storage)]
pub global STORAGE_LAYOUT_Token: StorageLayout<5> = StorageLayout {
    contract_name: "Token",
    fields: StorageLayoutFields {
        admin: Storable { slot: 1 },
        balances: Storable { slot: 2 },
        // ...
    }
};
```

### #[note]

**File:** `aztec/src/macros/notes.nr`

**Why:** Register note types and generate required trait implementations.

**How:**
1. Validates the struct implements `Packable`
2. Registers the note type in global `NOTES` BoundedVec
3. Generates:
   - `NoteType` implementation with unique ID
   - `NoteHash` implementation for hash and nullifier computation
   - `NoteProperties` struct for property selectors

### #[event]

**File:** `aztec/src/macros/events.nr`

**Why:** Register event types and generate event interface.

**How:**
1. Computes event selector from struct signature
2. Checks for selector collisions
3. Generates `EventInterface` implementation
4. Derives `Serialize` if not already implemented
5. Adds `#[abi(events)]` attribute

### #[external("...")] and #[internal("...")]

**File:** `aztec/src/macros/functions/mod.nr`

**Why:** Categorize functions as external/internal and private/public/utility.

**How:**
1. Validates function constraints (visibility, unconstrained status)
2. Registers function in appropriate registry
3. Acts as marker for the `#[aztec]` macro to process

---

## The ContractSelf Struct

**File:** `aztec/src/contract_self.nr`

**Why:** Provide a unified interface for contract functions to interact with storage, context, and other contracts.

**Structure:**

```noir
pub struct ContractSelf<Context, Storage, CallSelf, EnqueueSelf, CallSelfStatic, EnqueueSelfStatic, CallInternal> {
    pub address: AztecAddress,
    pub storage: Storage,
    pub context: Context,
    pub call_self: CallSelf,
    pub enqueue_self: EnqueueSelf,
    pub call_self_static: CallSelfStatic,
    pub enqueue_self_static: EnqueueSelfStatic,
    pub internal: CallInternal,
}
```

**Implementations:**
- **Private context**: Full functionality including `call`, `view`, `enqueue`, `enqueue_view`, `emit`, `msg_sender`
- **Public context**: `call`, `view`, `emit`, `msg_sender`
- **Utility context**: Limited to storage access and context queries

---

## Complete Flow Diagram

```
Developer writes:
┌─────────────────────────────────────────────────────────┐
│ #[aztec]                                                │
│ pub contract Token {                                    │
│     #[storage]                                          │
│     struct Storage<Context> { ... }                     │
│                                                         │
│     #[external("private")]                              │
│     fn transfer(to: AztecAddress, amount: u128) { ... } │
│ }                                                       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   #[aztec] macro      │
              └───────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Validate     │  │ Process      │  │ Generate     │
│ Functions    │  │ Functions    │  │ Interface    │
└──────────────┘  └──────────────┘  └──────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ Generated Code        │
              │ ─────────────────     │
              │ • Token struct        │
              │ • Token::at()         │
              │ • Token::transfer()   │
              │ • CallSelf struct     │
              │ • EnqueueSelf struct  │
              │ • CallInternal struct │
              │ • transfer_abi struct │
              │ • public_dispatch()   │
              │ • sync_private_state()│
              │ • process_message()   │
              │ • __aztec_nr_inter... │
              └───────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Final Contract (simplified)                             │
│ ─────────────────────────────────────────────────────── │
│ pub struct Token { target_contract: AztecAddress }      │
│                                                         │
│ impl Token {                                            │
│     pub fn transfer(...) -> PrivateCall<...> { ... }    │
│     pub fn at(addr: AztecAddress) -> Self { ... }       │
│ }                                                       │
│                                                         │
│ fn __aztec_nr_internals__transfer(                      │
│     inputs: PrivateContextInputs,                       │
│     to: AztecAddress,                                   │
│     amount: u128                                        │
│ ) -> return_data PrivateCircuitPublicInputs {           │
│     // Context setup, storage init, security checks     │
│     // Original function body                           │
│     // Return value serialization                       │
│ }                                                       │
│                                                         │
│ // Original function - now uncallable                   │
│ #[contract_library_method]                              │
│ fn transfer(_to: AztecAddress, _amount: u128) {         │
│     static_assert(false, "Direct invocation not...");   │
│ }                                                       │
└─────────────────────────────────────────────────────────┘
```

---

## Summary

The `#[aztec]` macro is a sophisticated code generation system that transforms simple Noir contract code into a complete Aztec smart contract with:

1. **Entry point functions** that set up execution contexts and handle kernel circuit requirements
2. **Security infrastructure** including initialization checks, view enforcement, and authorization
3. **Ergonomic APIs** for cross-contract calls, self-calls, and internal function invocation
4. **ABI exports** for tooling and SDK integration
5. **Note processing** infrastructure for private state management
6. **Public dispatch** routing for AVM execution

Understanding these transformations is essential for:
- Debugging contract compilation issues
- Understanding the runtime behavior of contract functions
- Extending or customizing contract functionality
- Contributing to the Aztec.nr framework
