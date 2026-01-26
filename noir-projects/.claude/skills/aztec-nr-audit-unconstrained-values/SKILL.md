---
name: aztec-nr-audit-unconstrained-values
description: Audit Aztec contracts for unconstrained witness values. Finds values derived from unconstrained functions or oracles that are used in constrained contexts without proper validation, enabling proof forgery by malicious provers.
---

# Unconstrained Values Audit

## Purpose
Find witness values that flow from unconstrained contexts into constrained logic without validation.

## Background

Aztec circuits have two execution modes:
- **Constrained**: Creates proof, values must satisfy constraints
- **Unconstrained**: No proof, arbitrary computation allowed

Values from unconstrained functions are **witness values** - the prover provides them. A malicious prover can set any value. These MUST be validated before use in constrained logic.

## Vulnerability Pattern

```noir
// VULNERABLE: Unconstrained value used in constrained context
#[external("private")]
fn process_data() {
    let value = compute_unconstrained();  // Prover controls this
    assert(value > 0);  // Prover just sets value = 1
    // ... use value in critical logic
}

unconstrained fn compute_unconstrained() -> Field {
    // Complex computation
    some_oracle_call()
}
```

```noir
// SAFE: Value validated against constrained source
#[external("private")]
fn process_data() {
    let value = compute_unconstrained();
    let expected = compute_constrained();  // From circuit logic
    assert(value == expected);  // Now value is constrained!
}
```

## Workflow

### Step 1: Find Unconstrained Functions
```bash
# Find unconstrained function definitions
grep -rn "unconstrained\s*fn" noir-projects/noir-contracts/ --include="*.nr"

# Find unconstrained blocks
grep -rn "unconstrained\s*{" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 2: Trace Unconstrained Value Flow
For each unconstrained function:
1. Where is it called?
2. How is the return value used?
3. Is it validated against constrained data?

```bash
# Find calls to unconstrained functions (look for function names found in step 1)
grep -rn "let.*=.*_unconstrained\|let.*=.*compute_.*unconstrained" \
  noir-projects/noir-contracts/ --include="*.nr"
```

### Step 3: Identify Validation Gaps

**Look for unconstrained values used in**:
- Control flow decisions (`if`, `assert`)
- State modifications
- Output values
- Loop bounds
- Array indices

```bash
# Find assertions using potentially unconstrained values
grep -B5 "assert\|if\s" noir-projects/noir-contracts/ --include="*.nr" | \
  grep -A5 "unconstrained\|unsafe"
```

### Step 4: Check Validation Patterns

**Safe patterns**:
```noir
// Hash commitment
let unconstrained_note = get_note_unconstrained();
let hash = unconstrained_note.compute_hash();
context.push_note_hash_read_request(hash);  // Kernel validates hash exists

// Merkle membership
let witness = get_witness_unconstrained();
verify_membership(leaf, witness, root);  // Circuit verifies

// Re-computation
let hint = compute_hint_unconstrained();
let computed = compute_constrained(inputs);
assert(hint == computed);
```

**Unsafe patterns**:
```noir
// Direct use in control flow
let result = check_unconstrained();
if result {  // Prover controls branch
    privileged_operation();
}

// Direct use in arithmetic
let factor = get_factor_unconstrained();
let output = input * factor;  // Prover controls output
```

### Step 5: Special Cases

**Loop bounds from unconstrained** (Critical):
```noir
// CRITICAL: Prover controls iteration count
let count = get_count_unconstrained();
for i in 0..count {  // May not even compile, but watch for BoundedVec patterns
    process(i);
}
```

**Array indices from unconstrained** (High):
```noir
// HIGH: Prover controls array access
let index = get_index_unconstrained();
let value = array[index];  // Out of bounds possible
```

## False Positive Patterns

### Utility Functions (Lower Risk)
```noir
#[external("utility")]
unconstrained fn view_balance() -> Field {
    // Not part of proof - just a view function
    storage.balance.read()
}
```

### Hint Followed by Constraint (Safe)
```noir
let hint = compute_hint_unconstrained();
// ... later ...
assert(verify(hint, constrained_data));  // Hint is now constrained
```

### Framework-Wrapped Calls (Usually Safe)
```noir
// Framework handles validation internally
let notes = storage.set.get_notes(options);  // Validated by framework
```

## Example Findings

### Critical: Unconstrained Balance Check
```noir
// lending.nr:200
#[external("private")]
fn borrow(amount: Field) {
    // CRITICAL: Prover sets collateral_value
    let collateral_value = get_collateral_value_unconstrained();
    assert(collateral_value >= amount * 2);  // Prover bypasses collateral check
    mint_debt(amount);
}
```

### High: Unconstrained Array Index
```noir
// voting.nr:150
#[external("private")]
fn vote(proposal_index: Field) {
    // HIGH: Prover could access invalid index
    let proposal = get_proposal_unconstrained(proposal_index);
    // ... no bounds check on proposal_index
}
```

### Medium: Unconstrained Branch Decision
```noir
// auction.nr:180
#[external("private")]
fn finalize_auction() {
    let is_winner = check_winner_unconstrained();  // MEDIUM
    if is_winner {
        transfer_prize();  // Prover claims prize without being winner
    }
}
```

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-unconstrained-values` |
| Target | `{path audited}` |
| Unconstrained Functions | `{number}` |
| Findings | `{e.g., "1 Critical, 2 High" or "None"}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `unconstrained-{contract}-{function}-{line}`
- **Severity**: Critical / High / Medium / Low
- **File**: `path/to/file.nr:line`
- **Source**: Which unconstrained function/value
- **Usage**: How the unconstrained value is used
- **Fix**: Add validation constraint

### JSON Output
Write to `aztec-nr-audit-unconstrained-values.json`:
```json
{
  "skill": "aztec-nr-audit-unconstrained-values",
  "status": "COMPLETED_WITH_FINDINGS",
  "findings": [
    {
      "id": "unconstrained-lending-borrow-200",
      "severity": "critical",
      "file": "noir-contracts/contracts/lending/src/main.nr",
      "line": 200,
      "source": "get_collateral_value_unconstrained()",
      "usage": "Used in assert for collateral check without validation",
      "description": "Collateral value from unconstrained function used directly in borrow check",
      "exploitability": "high",
      "fix": "Validate collateral value against public storage or merkle proof"
    }
  ]
}
```
