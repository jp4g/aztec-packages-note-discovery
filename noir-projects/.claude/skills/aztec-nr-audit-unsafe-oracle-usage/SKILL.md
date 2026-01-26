---
name: aztec-nr-audit-unsafe-oracle-usage
description: Audit Aztec contracts for unsafe oracle usage. Finds cases where oracle results are used without proper validation, enabling malicious provers to inject arbitrary witness values. Critical for soundness of private function execution.
---

# Unsafe Oracle Usage Audit

## Purpose
Find cases where oracle results (untrusted prover hints) are used without constraint validation.

## Background

In Aztec, oracles provide hints from the prover to the circuit. These are **untrusted** - a malicious prover can return arbitrary values. The circuit must validate oracle results against constrained values.

The aztec-nr framework marks dangerous oracle functions with `unsafe`:
```noir
pub unconstrained unsafe fn get_note_internal<Note, let N: u32>(...) -> Note
```

## Vulnerability Pattern

```noir
// VULNERABLE: Oracle result used without validation
let note = unsafe { get_note_internal(...) };
// Using `note` directly trusts the prover

// SAFE: Oracle result validated against commitment
let note = unsafe { get_note_internal(...) };
let computed_hash = note.compute_note_hash();
assert(computed_hash == expected_hash_from_tree);  // Validation!
```

## Workflow

### Step 1: Find All Oracle Calls
```bash
# Find unsafe blocks in contracts
grep -rn "unsafe\s*{" noir-projects/noir-contracts/ --include="*.nr"

# Find oracle module usage
grep -rn "oracle::" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 2: Identify Unsafe Oracle Functions
Key unsafe oracles in aztec-nr:
```bash
# List unsafe functions in oracle module
grep -rn "pub.*unsafe\s*fn\|unconstrained.*unsafe" \
  noir-projects/aztec-nr/aztec/src/oracle/ --include="*.nr"
```

Common unsafe oracles:
- `get_note_internal` - Returns note from storage
- `get_nullifier_membership_witness` - Returns nullifier tree witness
- `get_public_data_witness` - Returns public storage witness
- `get_contract_instance` - Returns contract instance data
- `auth_witness` - Returns authorization witness

### Step 3: Trace Oracle Result Usage
For each oracle call found:
1. What value is returned?
2. Is it validated against a constrained value?
3. Is it used in security-critical logic?

```bash
# Find patterns where oracle result is used in assertions or state changes
grep -A10 "unsafe\s*{.*oracle" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 4: Check Validation Patterns

**Safe patterns**:
```noir
// Hash validation
let note = unsafe { get_note(...) };
let hash = note.compute_hash();
context.push_note_hash_read_request(hash);  // Kernel validates

// Membership proof
let witness = unsafe { get_membership_witness(...) };
assert_membership(leaf, witness, root);  // Circuit validates

// Nullifier check
let exists = unsafe { check_nullifier_exists(...) };
context.push_nullifier_read_request(nullifier);  // Kernel validates
```

**Unsafe patterns**:
```noir
// Direct use without validation
let balance = unsafe { get_public_storage_value(...) };
assert(balance > amount);  // UNSAFE: prover controls balance

// Trusting contract instance
let instance = unsafe { get_contract_instance(...) };
let owner = instance.deployer;  // UNSAFE: prover controls deployer
```

### Step 5: Framework vs Contract Analysis

The aztec-nr framework itself uses unsafe oracles but adds validation. Focus on:
1. **Contract code** using oracles directly (higher risk)
2. **Custom oracle calls** not through framework wrappers
3. **State variable implementations** in custom code

## False Positive Patterns

### Framework-Wrapped Calls (Usually Safe)
```noir
// Using framework's validated wrappers
let notes = storage.notes.get_notes(options);  // Framework validates
```

### Unconstrained Functions (Lower Risk)
```noir
unconstrained fn view_balance() -> Field {
    // Unconstrained context - not part of proof
    unsafe { get_public_storage_value(...) }
}
```

### Read Requests (Safe)
```noir
// Push to read request array - kernel validates
context.push_note_hash_read_request(hash);
```

## Example Findings

### Critical: Unvalidated Balance Check
```noir
// custom_contract.nr:80
#[external("private")]
fn withdraw_if_sufficient(amount: Field) {
    // CRITICAL: Prover can lie about balance
    let balance = unsafe { get_public_storage_at(BALANCE_SLOT) };
    assert(balance >= amount);  // No kernel validation!
    // ... proceed with withdrawal
}
```

### High: Unvalidated Contract Instance
```noir
// escrow.nr:120
#[external("private")]
fn release_to_deployer() {
    // HIGH: Prover controls instance.deployer
    let instance = unsafe { get_contract_instance(self.address) };
    let deployer = instance.deployer;
    // ... sends funds to deployer
}
```

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-unsafe-oracle-usage` |
| Target | `{path audited}` |
| Files Scanned | `{number}` |
| Findings | `{e.g., "1 Critical, 1 High" or "None"}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `unsafe-oracle-{contract}-{line}-{oracle-type}`
- **Severity**: Critical / High / Medium / Low
- **File**: `path/to/file.nr:line`
- **Oracle**: Which oracle function is called
- **Issue**: How the result is used unsafely
- **Fix**: Add validation or use framework wrapper

### JSON Output
Write to `aztec-nr-audit-unsafe-oracle-usage.json`:
```json
{
  "skill": "aztec-nr-audit-unsafe-oracle-usage",
  "status": "COMPLETED_WITH_FINDINGS",
  "findings": [
    {
      "id": "unsafe-oracle-escrow-120-get_contract_instance",
      "severity": "high",
      "file": "noir-contracts/contracts/escrow/src/main.nr",
      "line": 120,
      "oracle": "get_contract_instance",
      "description": "Contract instance deployer field used without validation",
      "exploitability": "high",
      "fix": "Validate instance hash against registered contract or use framework method"
    }
  ]
}
```
