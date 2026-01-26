# Security Review: Aztec Macro System

**Review Date**: January 2026
**Reviewer**: Claude (Security Analysis)
**Scope**: `noir-projects/aztec-nr/aztec/src/macros/`

---

## Executive Summary

The Aztec macro system is the compile-time code generation layer that transforms developer-written contract functions into circuits compatible with the Aztec protocol. This review identifies **10 security-relevant findings** ranging from known unsafe patterns to potential design risks.

**Key Findings**:
- 1 HIGH severity known issue (public initialization check)
- 1 HIGH severity design risk (storage slot ordering)
- 3 MEDIUM severity concerns
- 5 LOW severity items

---

## Architecture Overview

### Code Flow

```
Contract Source Code
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│  #[aztec] macro (aztec.nr:21)                                 │
│  ├── check_each_fn_macroified() - validate all fns annotated  │
│  ├── process_functions() - transform external/internal fns    │
│  ├── generate_contract_interface() - create call stubs        │
│  ├── generate_public_dispatch() - selector routing            │
│  └── generate helper fns (_compute_note_hash_and_nullifier)   │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│  Per-Function Transformation (private.nr)                     │
│  ├── Prepend: oracle version check, context init, storage     │
│  ├── Prepend: phase tracking, init checks, access controls    │
│  ├── Append: return value hashing, mark initialized           │
│  ├── Append: phase consistency check, context.finish()        │
│  └── Original fn body → static_assert(false)                  │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
Generated Contract (returns PrivateCircuitPublicInputs)
```

### Key Files Reviewed

| File | Purpose |
|------|---------|
| `aztec.nr` | Main macro orchestrator |
| `internals_functions_generation/mod.nr` | Function transformation dispatcher |
| `internals_functions_generation/external/private.nr` | Private function code injection |
| `internals_functions_generation/external/helpers.nr` | Authorization check generation |
| `functions/initialization_utils.nr` | Contract initialization logic |
| `dispatch.nr` | Public function selector routing |
| `storage.nr` | Storage slot assignment |
| `utils.nr` | Selector computation, type signatures |

---

## Findings

### Finding #1: Public Initialization Check is Explicitly Unsafe

**Severity**: HIGH
**Location**: `initialization_utils.nr:29-37`
**Status**: Known Issue (F-239)

```noir
pub fn assert_is_initialized_public(context: PublicContext) {
    let init_nullifier = compute_unsiloed_contract_initialization_nullifier(context.this_address());
    // Safety: TODO(F-239) - this is currently unsafe, we cannot rely on the nullifier existing to determine that any
    // public component of contract initialization has been complete.
    assert(
        context.nullifier_exists_unsafe(init_nullifier, context.this_address()),
        "Not initialized",
    );
}
```

**Analysis**: The comment explicitly states this check is **unsafe**. The `nullifier_exists_unsafe` function name confirms this is a known limitation.

**Security Implication**: Public functions on contracts with initializers may be callable before initialization is complete in certain edge cases. This could allow:
- Accessing uninitialized storage
- Bypassing initialization-time access controls

**Recommendation**:
- Track F-239 resolution
- Audit all public functions in contracts with initializers
- Consider adding explicit warnings to documentation

---

### Finding #2: Storage Slot Assignment is Position-Dependent

**Severity**: HIGH
**Location**: `storage.nr:34-82`
**Type**: Design Risk

```noir
let mut slot: u32 = 1;  // Slots start at 1
// ...
for storage_struct_member in s.fields_as_written() {
    // ...
    slot += storage_size;  // Increment by type's storage size
}
```

**Analysis**: Storage slots are assigned **sequentially based on struct field order**. If a developer reorders fields in a deployed contract, all data becomes corrupted.

**Example of Breaking Change**:
```noir
// V1
#[storage]
struct Storage<Context> {
    owner: PublicMutable<AztecAddress>,   // slot 1
    balance: Map<AztecAddress, U128>,     // slots 2+
}

// V2 - BREAKS STORAGE
#[storage]
struct Storage<Context> {
    balance: Map<AztecAddress, U128>,     // NOW slot 1 (was 2+)
    owner: PublicMutable<AztecAddress>,   // NOW slot 5+ (was 1)
}
```

**Security Implications**:
- **Upgrade safety**: Reordering fields breaks storage
- **Addition safety**: Adding fields at the end is safe
- **Removal safety**: Removing fields shifts all subsequent slots

**Recommendation**:
- Add compile-time slot verification for upgrades
- Consider explicit slot annotations
- Document this behavior prominently

---

### Finding #3: Zero Deployer Allows Permissionless Initialization

**Severity**: MEDIUM
**Location**: `initialization_utils.nr:56-59` and `initialization_utils.nr:68-70`

```noir
assert(
    (deployer.is_zero()) | (deployer == context.msg_sender().unwrap()),
    "Initializer address is not the contract deployer",
);
```

**Analysis**: If `deployer.is_zero()`, **anyone** can call the initializer. This is by design (for permissionless deployment) but could be surprising to developers.

**Security Implication**: Contracts deployed without a specified deployer can be initialized by anyone. If initialization parameters affect access control, this could be exploited.

**Recommendation**:
- Document this behavior clearly
- Consider adding a `#[requires_deployer]` attribute for contracts that need it

---

### Finding #4: Generic Array Length in Selector Computation

**Severity**: MEDIUM
**Location**: `utils.nr:66-70`

```noir
let array_len = if array_len.as_constant().is_some() {
    let const_len = array_len.as_constant().unwrap();
    f"{const_len}".quoted_contents()
} else {
    // If array length is not a constant, chances are it's a numeric generic
    // This will make the signature of a type like Struct<N> be the same regardless
    // of the value of N
    f"{array_len}".quoted_contents()
};
```

**Analysis**: When array length is a generic (not constant), the signature includes the generic parameter name, not the resolved value.

**Security Implication**: Two functions with different generic instantiations could have the same selector:
- `foo(arr: [Field; N])` where N=10
- `foo(arr: [Field; N])` where N=20

Both would have signature `foo([Field;N])` - same selector!

**Recommendation**:
- Investigate if this can cause selector collisions in practice
- Consider resolving generics before signature computation

---

### Finding #5: Phase Change Detection Can Be Bypassed

**Severity**: MEDIUM
**Location**: `private.nr:104-120`

```noir
let initial_phase_store = if fn_has_nophasecheck(f) {
    quote {}
} else {
    quote { let within_revertible_phase: bool = self.context.in_revertible_phase(); }
};
```

**Analysis**: The `#[nophasecheck]` attribute completely disables phase tracking. A developer using this incorrectly could create functions that behave inconsistently.

**Security Implication**: Functions with `#[nophasecheck]` can execute operations across phase boundaries, potentially causing unexpected behavior.

**Recommendation**:
- Audit all uses of `#[nophasecheck]` in the codebase
- Document when this attribute is appropriate
- Consider adding compile-time warnings when used

---

### Finding #6: Initialization Nullifier Has No Domain Separation

**Severity**: LOW
**Location**: `initialization_utils.nr:45-47`

```noir
fn compute_unsiloed_contract_initialization_nullifier(address: AztecAddress) -> Field {
    address.to_field()
}
```

**Analysis**: The initialization nullifier is simply the contract address converted to a Field, with no domain separator.

**Question**: Could there be a collision with other nullifier types that also use raw Field values without domain separation?

**Recommendation**: Verify no other nullifier computation uses raw addresses without domain separation.

---

### Finding #7: Authorize_once Attribute Order Dependency

**Severity**: LOW
**Location**: `helpers.nr:54-59`

```noir
let authorize_once_args = if maybe_authorize_once_args.is_some() {
    maybe_authorize_once_args.unwrap()
} else {
    panic(
        f"Functions marked with #[authorize_once] must have the #[external(\"private\")] or #[external(\"public\")] attribute placed last",
    )
};
```

**Analysis**: The `#[authorize_once]` attribute **must** be placed before `#[external]` due to macro evaluation order.

**Security Implication**: This is a compile-time failure, not a runtime vulnerability. However, if a developer removes the `#[authorize_once]` attribute to "fix" the error, they may accidentally remove authorization.

**Recommendation**: Consider making this order-independent or providing clearer guidance.

---

### Finding #8: Selector Collision Detection is Contract-Local Only

**Severity**: LOW
**Location**: `dispatch.nr:23-32`

```noir
if seen_selectors.contains_key(selector) {
    let existing_fn = seen_selectors.get(selector).unwrap();
    panic(
        f"Public function selector collision detected between functions '{fn_name}' and '{existing_fn}'",
    );
}
```

**Analysis**: Collision detection only happens within a single contract. Cross-contract selector collisions are possible but may not be a security issue since selectors are per-contract.

**Recommendation**: Document that selectors are contract-local; verify external tooling doesn't assume global uniqueness.

---

### Finding #9: Return Value Hashing Loses Information

**Severity**: LOW
**Location**: `private.nr:143-152`

**Analysis**: Return values are serialized and hashed. The hash is what gets included in the proof, not the actual value.

**Security Implication**: Callers cannot cryptographically verify the exact return value from the proof alone - they only get the hash. This is intentional (for privacy) but could be surprising.

**Recommendation**: Document this behavior for contract developers.

---

### Finding #10: Nonce Check Logic in authorize_once

**Severity**: INFORMATIONAL (Verified Correct)
**Location**: `helpers.nr:106-112`

```noir
if (!$from_arg_name_quoted.eq(self.msg_sender().unwrap())) {
    $fn_call(self.context, $from_arg_name_quoted);
} else {
    assert($nonce_check_quote, $invalid_nonce_message);
}
```

**Analysis**: When `from == msg_sender`, only the nonce is checked (must be 0). When `from != msg_sender`, full authwit validation occurs.

**Verification**: This logic is correct - if you're the sender, you don't need authorization from yourself. The nonce=0 requirement prevents accidentally consuming an authwit when you don't need one.

---

## Summary Table

| # | Finding | Severity | Type | Status |
|---|---------|----------|------|--------|
| 1 | Public init check unsafe | HIGH | Known Issue | F-239 tracked |
| 2 | Storage slot ordering | HIGH | Design Risk | Document + tooling needed |
| 3 | Zero deployer allowed | MEDIUM | Design Choice | Document |
| 4 | Generic array selectors | MEDIUM | Potential Bug | Investigate |
| 5 | Nophasecheck bypass | MEDIUM | Design Risk | Audit uses |
| 6 | Init nullifier no domain sep | LOW | Design Question | Verify |
| 7 | Attribute order dependency | LOW | UX Issue | Improve error |
| 8 | Local selector collision | LOW | Design Choice | Document |
| 9 | Return value hashing | LOW | Design Choice | Document |
| 10 | Nonce check logic | INFO | Verified | Correct |

---

## Recommended Next Steps

1. **Track F-239**: Understand the public initialization safety issue and timeline for resolution
2. **Review `nullifier_exists_unsafe`**: Understand what makes it unsafe and implications
3. **Audit `#[nophasecheck]` usage**: Search codebase for all uses and verify appropriateness
4. **Test generic array selector**: Create test case to verify collision potential
5. **Review authwit consumption**: Trace `assert_current_call_valid_authwit` implementation
6. **Storage upgrade tooling**: Consider adding slot verification for contract upgrades

---

## Protocol Boundary Notes

This review focused on the macro system. The boundary between aztec-nr and protocol circuits operates on a "claim and verify" model:

| Produced by App Circuit | Validated by Kernel |
|------------------------|---------------------|
| `PrivateCircuitPublicInputs` | Full constraint validation |
| Claimed array lengths | Density checks |
| Side effect counters | Uniqueness + bounds checking |
| Read requests | Against pending/settled state |

Key insight: The app circuit claims everything, but the kernel validates everything through constraints. This is a well-designed trust boundary.

---

*This review was conducted as part of an ongoing security assessment of the aztec-nr framework.*
