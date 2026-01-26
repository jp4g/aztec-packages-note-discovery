---
name: aztec-nr-audit-feature-interactions
description: Systematically analyze aztec-nr framework features for dangerous combinations. Enumerates macros, attributes, state variables, and patterns, then theorizes about unsafe interactions when users combine them in unexpected ways. Use for finding emergent bugs in feature composition.
---

# Feature Interaction Analysis

## Purpose
Find bugs that emerge when aztec-nr features are combined in ways the framework authors didn't anticipate. This is a systematic analysis skill, not a pattern-matching skill.

## Methodology

1. **Enumerate features** - Catalog all attributes, state vars, note types, context operations
2. **Build interaction matrix** - Consider pairwise and n-way combinations
3. **Theorize failure modes** - For each interesting combination, reason about what could go wrong
4. **Validate with code** - Check if the framework prevents the dangerous case
5. **Generate test cases** - Create minimal examples that demonstrate the issue

## Phase 1: Feature Enumeration

### Function Attributes (Macros)

Enumerate by reading `aztec-nr/aztec/src/macros/`:

```bash
# Find all attribute macros
grep -rn "pub.*comptime.*fn\|has_named_attribute" \
  noir-projects/aztec-nr/aztec/src/macros/ --include="*.nr"
```

**Known attributes**:
| Attribute | Effect | File |
|-----------|--------|------|
| `#[aztec]` | Marks module as contract, generates interface | `aztec.nr` |
| `#[external("private")]` | Private function (client-proved) | `functions/mod.nr` |
| `#[external("public")]` | Public function (sequencer-executed) | `functions/mod.nr` |
| `#[external("utility")]` | Unconstrained helper function | `functions/mod.nr` |
| `#[internal("private")]` | Internal private function | `functions/mod.nr` |
| `#[internal("public")]` | Internal public function | `functions/mod.nr` |
| `#[initializer]` | One-time initialization function | `functions/mod.nr` |
| `#[noinitcheck]` | Skip initialization check | `functions/mod.nr` |
| `#[nophasecheck]` | Skip phase consistency check | `functions/mod.nr` |
| `#[only_self]` | Only callable by same contract | `functions/mod.nr` |
| `#[view]` | Read-only (static call) | `functions/mod.nr` |
| `#[authorize_once]` | Require authwit for `from` parameter | `authorization.nr` |
| `#[storage]` | Marks storage struct | `storage.nr` |
| `#[note]` | Marks note struct | `notes.nr` |
| `#[event]` | Marks event struct | `events.nr` |

### State Variable Types

Enumerate from `aztec-nr/aztec/src/state_vars/`:

| Type | Ownership | Context | Behavior |
|------|-----------|---------|----------|
| `PublicMutable<T>` | None | Public | Direct read/write |
| `PublicImmutable<T>` | None | Public | Write-once |
| `PrivateMutable<Note>` | Owner | Private | Single note, owner-only mutation |
| `PrivateImmutable<Note>` | Owner | Private | Write-once note |
| `PrivateSet<Note>` | Per-note | Private | Multiple notes, others can insert |
| `Map<K, V>` | Varies | Both | Nested state variable |
| `Owned<V>` | Owner | Private | Ownership wrapper |

### Note Types (Standard Library)

| Note | Package | Purpose |
|------|---------|---------|
| `TokenNote` | aztec | Standard fungible token note |
| `ValueNote` | aztec | Generic field value note |
| `AddressNote` | address-note | AztecAddress storage |
| `FieldNote` | field-note | Simple field storage |
| `UintNote` | uint-note | u128 storage |

### Context Operations

| Operation | Context | Side Effect |
|-----------|---------|-------------|
| `push_note_hash()` | Private | Creates note |
| `push_nullifier()` | Private | Nullifies note |
| `push_note_hash_read_request()` | Private | Reads note |
| `push_nullifier_read_request()` | Private | Checks nullifier |
| `call_private_function()` | Private | Nested call |
| `enqueue_public_function()` | Private | Schedules public |
| `storage_read()` | Public | Reads storage |
| `storage_write()` | Public | Writes storage |

## Phase 2: Interaction Analysis

For each pair/group of features, ask:

1. **Can they be combined?** (Compile-time or runtime restriction?)
2. **What happens if combined?** (Expected behavior?)
3. **What could go wrong?** (Edge cases, ordering, state)
4. **Does the framework prevent it?** (Read the code)
5. **Can a user bypass prevention?** (Creative misuse)

### High-Priority Interactions to Analyze

#### 1. `#[initializer]` + `#[authorize_once]`
**Question**: Can authwit be validated before initialization nullifier exists?

```bash
# Check macro ordering and generated code
grep -A30 "is_fn_initializer" noir-projects/aztec-nr/aztec/src/macros/internals_functions_generation/external/private.nr
```

**Concerns**:
- Does authwit check happen before or after init assertion?
- Can attacker use authwit on uninitialized contract?

#### 2. `#[nophasecheck]` + State Operations
**Question**: What operations are phase-dependent and break with nophasecheck?

```bash
# Find what depends on phase
grep -rn "in_revertible_phase\|revertible" noir-projects/aztec-nr/aztec/src/
```

**Concerns**:
- State ops that assume specific phase
- Cross-phase data inconsistency

#### 3. `#[only_self]` + Enqueued Public Calls
**Question**: If private function enqueues public, is `only_self` enforced correctly?

```bash
# Check only_self implementation
grep -A10 "is_fn_only_self" noir-projects/aztec-nr/aztec/src/macros/
```

**Concerns**:
- `msg_sender` in public context vs private context
- Enqueued call has different sender?

#### 4. `#[view]` + Note Operations
**Question**: Can a view function accidentally create side effects?

```bash
# Check view enforcement
grep -A10 "is_fn_view" noir-projects/aztec-nr/aztec/src/macros/
```

**Concerns**:
- Static call should have no side effects
- Note reads might create read requests?

#### 5. PrivateSet + Multiple Contracts Inserting
**Question**: If contract A's PrivateSet allows contract B to insert, who owns the note?

```bash
# Check PrivateSet insert ownership
grep -A20 "fn insert" noir-projects/aztec-nr/aztec/src/state_vars/private_set.nr
```

**Concerns**:
- Note ownership vs storage ownership
- Who can nullify inserted notes?

#### 6. Nested Private Calls + AuthWit
**Question**: If A calls B with authwit, and B calls C, is auth properly scoped?

```bash
# Check authwit context handling
grep -rn "assert_current_call_valid_authwit" noir-projects/aztec-nr/aztec/src/authwit/
```

**Concerns**:
- Auth consumed in outer vs inner call
- Replay across nested calls

#### 7. `#[initializer]` + Multiple Initializers
**Question**: Can a contract have multiple initializer functions? What happens?

```bash
# Check initializer enforcement
grep -rn "mark_as_initialized\|assert_is_initialized" noir-projects/aztec-nr/aztec/src/
```

**Concerns**:
- Can second initializer be called after first?
- Init nullifier uniqueness

#### 8. balance-set + Concurrent Transfers
**Question**: How does balance-set handle concurrent in/out transfers?

```bash
# Read balance-set implementation
cat noir-projects/aztec-nr/balance-set/src/lib.nr
```

**Concerns**:
- Note selection during concurrent operations
- Under/overflow handling

#### 9. Storage Layout + Inheritance Patterns
**Question**: If contract B inherits patterns from A, do storage slots collide?

**Concerns**:
- Trait implementations with storage
- Diamond-like patterns

#### 10. Generic State Variables + Type Confusion
**Question**: Can `Map<K, PublicMutable<T>>` and `Map<K, PrivateMutable<Note>>` collide?

```bash
# Check Map storage slot derivation
grep -A20 "impl.*Map" noir-projects/aztec-nr/aztec/src/state_vars/map.nr
```

**Concerns**:
- Slot derivation for nested types
- Type confusion at same slot

## Phase 3: Generate Test Cases

For each concerning interaction, create a minimal contract that exercises it:

```noir
// test_interaction.nr
// Tests: #[initializer] + #[authorize_once] ordering

#[aztec]
contract TestInteraction {
    use dep::aztec::prelude::*;

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress>,
    }

    // Does authwit check happen before init check?
    #[authorize_once("from", "nonce")]
    #[initializer]
    #[external("private")]
    fn initialize(from: AztecAddress, admin: AztecAddress, nonce: Field) {
        storage.admin.initialize(admin);
    }
}
```

## Phase 4: Report Findings

### For Each Dangerous Interaction Found

Document:
1. **Features involved**: Which attributes/types/operations
2. **The interaction**: How they combine
3. **The bug**: What goes wrong
4. **Severity**: Impact assessment
5. **Proof**: Minimal example or code path
6. **Fix**: How framework should prevent it

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-feature-interactions` |
| Features Enumerated | `{number}` |
| Interactions Analyzed | `{number}` |
| Dangerous Combinations Found | `{number}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `interaction-{feature1}-{feature2}-{issue}`
- **Features**: List of features involved
- **Interaction**: How they combine
- **Issue**: What goes wrong
- **Severity**: Critical / High / Medium / Low
- **Evidence**: Code path or example
- **Fix**: Suggested prevention

### JSON Output
Write to `aztec-nr-audit-feature-interactions.json`:
```json
{
  "skill": "aztec-nr-audit-feature-interactions",
  "status": "COMPLETED_WITH_FINDINGS",
  "features_enumerated": 25,
  "interactions_analyzed": 15,
  "findings": [
    {
      "id": "interaction-initializer-authorize_once-ordering",
      "features": ["#[initializer]", "#[authorize_once]"],
      "interaction": "Both attributes on same function",
      "issue": "Authwit check occurs before initialization assertion",
      "severity": "medium",
      "evidence": "See private.nr:87 - authorize_once_check before init_check",
      "exploitability": "low",
      "fix": "Reorder checks so init_check precedes authorize_once_check"
    }
  ]
}
```

## Reference: Macro Application Order

From `private.nr`, the injected code order is:
```noir
// 1. Oracle version check
// 2. Contract self creation (context, storage)
// 3. Phase tracking (if not nophasecheck)
// 4. Assert initializer matches preimage (if initializer)
// 5. Init check (if module has initializer and not noinitcheck)
// 6. Internal check (only_self)
// 7. View check
// 8. Authorize once check
// ... user code ...
// 9. Return value handling
// 10. Mark as initialized (if initializer)
// 11. Phase consistency check (if not nophasecheck)
// 12. context.finish()
```

Understanding this order is critical for finding interaction bugs.
