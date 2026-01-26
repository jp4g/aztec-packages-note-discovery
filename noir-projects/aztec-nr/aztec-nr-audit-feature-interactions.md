# Feature Interaction Audit Report

## Summary Table

| Item                         | Value                                 |
| ---------------------------- | ------------------------------------- |
| Skill                        | `aztec-nr-audit-feature-interactions` |
| Target                       | `noir-projects/aztec-nr/`             |
| Features Enumerated          | 28                                    |
| Interactions Analyzed        | 10                                    |
| Dangerous Combinations Found | 10                                    |
| Status                       | `COMPLETED_WITH_FINDINGS`             |

## Severity Breakdown

- **High**: 2 findings
- **Medium**: 3 findings
- **Low**: 5 findings

---

## High Severity Findings

### 1. `#[noinitcheck]` + Uninitialized Storage Reads

**ID**: `interaction-noinitcheck-uninitialized-storage`

**Features**: `#[noinitcheck]`, storage reads

**Interaction**: Functions with `#[noinitcheck]` reading storage that is only set during initialization.

**Issue**: Functions can be called before initialization completes, reading uninitialized (zero) values. Critical security checks like `owner == msg_sender` may pass unexpectedly if `owner` is zero.

**Evidence**: `private.nr:97-101` - init_check is skipped when `fn_has_noinitcheck(f)`. No runtime protection for storage reads.

**Example Vulnerable Pattern**:

```noir
#[noinitcheck]
#[external("private")]
fn dangerous_before_init() {
    let owner = storage.owner.read();  // Returns zero if uninitialized
    assert(self.msg_sender() == owner);  // May pass if attacker is address(0)
}
```

**Fix**: Framework should warn when `#[noinitcheck]` functions read storage fields only written in `#[initializer]`. Alternatively, provide `assert_is_initialized_unsafe()` for explicit opt-in.

---

### 2. Public Initialization Check Is Unsafe (F-239)

**ID**: `interaction-public-init-f239-unsafe`

**Features**: `#[initializer]`, `#[external("public")]`, initialization check

**Interaction**: Public functions in contracts with initializers may be callable before initialization.

**Issue**: `assert_is_initialized_public` uses `nullifier_exists_unsafe` which is documented as unsafe. Public functions may execute before the initialization nullifier is confirmed to exist.

**Evidence**: `initialization_utils.nr:29-37`:

```noir
// Safety: TODO(F-239) - this is currently unsafe, we cannot rely on the nullifier
// existing to determine that any public component of contract initialization has
// been complete.
```

**Fix**: Track F-239 resolution. Consider adding framework-level warning when contracts have both `#[initializer]` and public functions that read initialized state.

---

## Medium Severity Findings

### 3. `#[authorize_once]` + `#[initializer]` + Zero Deployer

**ID**: `interaction-authorize_once-initializer-zero_deployer`

**Features**: `#[authorize_once]`, `#[initializer]`, zero deployer

**Interaction**: When `#[authorize_once]` is combined with `#[initializer]` and contract deployed with zero deployer.

**Issue**: `authorize_once` provides no additional access control when deployer is zero. The check order is:

1. `assert_initialization_matches_address_preimage_private` (allows anyone if deployer==0)
2. `authorize_once_check`

If caller sets `from=msg_sender` (themselves), the check passes with `nonce=0` since the `from == msg_sender` branch only validates nonce.

**Evidence**:

- `private.nr:176-185` shows check order
- `helpers.nr:107-111` shows `from == msg_sender` branch only checks `nonce == 0`

**Fix**: Document that `authorize_once` on initializers requires non-zero deployer for access control, or add explicit deployer check within `authorize_once` when `is_fn_initializer`.

---

### 4. PrivateSet External Insertion

**ID**: `interaction-privateset-external-insert`

**Features**: `PrivateSet`, external note insertion

**Interaction**: External contracts inserting notes into another contract's PrivateSet.

**Issue**: Anyone can insert notes into a PrivateSet. The owner of the PrivateSet (not the inserter) becomes the owner who can nullify. Inserter loses control of inserted value/notes.

**Evidence**: `private_set.nr:87-91`:

> "Other people can insert notes into the set" but "owner is still the only person with ability to remove notes"

**Consequences**:

- Griefing attacks (insert spam notes)
- Locked funds (inserter loses access to deposited value)

**Fix**: Provide clear documentation/patterns for when external insertion is intended. Consider `PrivateSetRestricted` that only allows owner to insert.

---

### 5. Storage Reordering Footgun

**ID**: `interaction-storage-reordering-footgun`

**Features**: `#[storage]`, storage slot assignment

**Interaction**: Reordering storage struct fields between contract versions.

**Issue**: Storage slots are assigned sequentially starting at 1 based on field order. Reordering fields changes slot assignments, corrupting data.

**Evidence**: `storage.nr:34-81`:

```noir
let mut slot: u32 = 1;
// ...
slot += storage_size;
```

**Example**:

```noir
// V1:
struct Storage {
    balance: PublicMutable<Field>,  // slot 1
    owner: PublicMutable<Field>,    // slot 2
}

// V2 (accidentally reordered):
struct Storage {
    owner: PublicMutable<Field>,    // slot 1 - WAS balance!
    balance: PublicMutable<Field>,  // slot 2 - WAS owner!
}
```

**Fix**: Consider generating stable slot assignments based on field names (e.g., `hash(contract_name, field_name)`) or add tooling to detect storage layout changes.

---

## Low Severity Findings

### 6. `#[nophasecheck]` + Phase-Dependent Operations

Operations expecting revertible phase may be called in non-revertible phase or vice versa when `#[nophasecheck]` is used.

### 7. `#[only_self]` + `hide_msg_sender` Interaction

When `hide_msg_sender` is true in enqueued calls, `msg_sender` is set to `NULL_MSG_SENDER_CONTRACT_ADDRESS`. An `#[only_self]` check will fail unexpectedly.

### 8. `#[view]` + Note Read Requests

View functions reading notes create read requests as side effects. Static call enforcement at kernel level needs verification.

### 9. Nested AuthWit Scope

AuthWit granted for outer call doesn't authorize inner calls. This is correct behavior but should be documented clearly.

### 10. Multiple Initializers

Framework allows multiple `#[initializer]` functions. The init nullifier is the contract address, so calling any initializer prevents all others. First caller wins.

---

## Feature Enumeration

### Function Attributes Analyzed

| Attribute                | Location           | Check Order (Private)    |
| ------------------------ | ------------------ | ------------------------ |
| `#[external("private")]` | `functions/mod.nr` | -                        |
| `#[external("public")]`  | `functions/mod.nr` | -                        |
| `#[initializer]`         | `functions/mod.nr` | 4th (assert_initializer) |
| `#[noinitcheck]`         | `functions/mod.nr` | Skips init_check         |
| `#[nophasecheck]`        | `functions/mod.nr` | Skips phase tracking     |
| `#[only_self]`           | `functions/mod.nr` | 6th (internal_check)     |
| `#[view]`                | `functions/mod.nr` | 7th (view_check)         |
| `#[authorize_once]`      | `authorization.nr` | 8th (last before body)   |

### Private Function Check Injection Order

From `private.nr:176-185`:

```
1. assert_compatible_oracle_version()
2. contract_self_creation
3. initial_phase_store (if not nophasecheck)
4. assert_initializer (if initializer)
5. init_check (if module has initializer and not noinitcheck)
6. internal_check (only_self)
7. view_check
8. authorize_once_check
--- user code ---
9. return_value
10. mark_as_initialized (if initializer)
11. no_phase_change_check (if not nophasecheck)
12. context.finish()
```

---

## Recommendations

1. **Add compile-time validation** for dangerous attribute combinations
2. **Track F-239 resolution** for public initialization safety
3. **Provide clearer documentation** for feature interactions
4. **Consider stable storage slot derivation** based on field names
5. **Add PrivateSetRestricted** or similar for controlled insertion patterns

---

## Files Analyzed

- `aztec/src/macros/internals_functions_generation/external/private.nr`
- `aztec/src/macros/internals_functions_generation/external/public.nr`
- `aztec/src/macros/internals_functions_generation/external/helpers.nr`
- `aztec/src/macros/functions/initialization_utils.nr`
- `aztec/src/macros/storage.nr`
- `aztec/src/authwit/auth.nr`
- `aztec/src/state_vars/private_set.nr`
- `aztec/src/state_vars/map.nr`
- `aztec/src/context/private_context.nr`
- `aztec/src/context/public_context.nr`
