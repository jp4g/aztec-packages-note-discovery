---
name: aztec-nr-audit-missing-authwit
description: Audit Aztec contracts for missing authorization checks. Finds functions that transfer value, modify ownership, or perform privileged operations without proper authwit validation. Critical for preventing unauthorized token transfers and state modifications.
---

# Missing Authorization Audit

## Purpose
Find functions that should require authorization but don't have `#[authorize_once]` or manual authwit checks.

## Vulnerability Pattern

Functions that operate "on behalf of" another address without verifying authorization:

```noir
// VULNERABLE: No authorization check
#[external("private")]
fn transfer(from: AztecAddress, to: AztecAddress, amount: Field) {
    // Transfers from `from` without proving `from` authorized this
    storage.balances.at(from).sub(amount);
    storage.balances.at(to).add(amount);
}
```

```noir
// SAFE: Has authorization
#[authorize_once("from", "nonce")]
#[external("private")]
fn transfer(from: AztecAddress, to: AztecAddress, amount: Field, nonce: Field) {
    // Macro injects authwit check for `from`
    storage.balances.at(from).sub(amount);
    storage.balances.at(to).add(amount);
}
```

## Workflow

### Step 1: Find Functions with "from" Parameters
```bash
# Find functions that take a "from" or "owner" parameter
grep -rn "fn.*from.*AztecAddress\|fn.*owner.*AztecAddress\|fn.*sender.*AztecAddress" \
  noir-projects/noir-contracts/ --include="*.nr"
```

### Step 2: Check for Authorization Attributes
For each function found, check if it has:
- `#[authorize_once("from", "nonce")]` attribute
- Manual `assert_current_call_valid_authwit` call
- `assert(from == self.msg_sender())` check

```bash
# Find functions WITHOUT authorize_once that have from parameter
grep -B5 "fn.*from.*AztecAddress" noir-projects/noir-contracts/ --include="*.nr" | \
  grep -v "authorize_once"
```

### Step 3: Identify High-Risk Patterns
Look for these operations without auth:
- `sub()` on balances with external `from`
- `remove()` on note sets with external `owner`
- `nullify()` operations
- State modifications keyed by external address

```bash
# Find balance modifications
grep -rn "\.sub\(.*from\|\.sub\(.*owner" noir-projects/noir-contracts/ --include="*.nr"

# Find note removals
grep -rn "\.remove\(.*from\|\.remove\(.*owner" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 4: Manual Review
For each candidate:
1. Read the function context
2. Determine if `from` is the `msg_sender()` (safe) or an external parameter (needs auth)
3. Check if authorization is handled differently (e.g., in a wrapper function)

## False Positive Patterns

### Self-Operations (Safe)
```noir
fn withdraw(amount: Field) {
    let from = self.msg_sender();  // from IS the caller
    storage.balances.at(from).sub(amount);
}
```

### Internal Functions (Often Safe)
```noir
#[internal("private")]
fn _transfer_internal(from: AztecAddress, to: AztecAddress, amount: Field) {
    // Only callable by the contract itself
}
```

### View Functions (Safe)
```noir
#[view]
fn balance_of(owner: AztecAddress) -> Field {
    // Read-only, no auth needed
}
```

## Example Findings

### Critical: Token Transfer Without Auth
```noir
// token_contract/src/main.nr:150
#[external("private")]
fn transfer(from: AztecAddress, to: AztecAddress, amount: Field) {
    // CRITICAL: Anyone can transfer anyone's tokens
    storage.balances.at(from).sub(amount);
    storage.balances.at(to).add(amount);
}
```

### Medium: Burn Without Auth
```noir
// token_contract/src/main.nr:200
#[external("private")]
fn burn(owner: AztecAddress, amount: Field) {
    // MEDIUM: Anyone can burn anyone's tokens
    storage.balances.at(owner).sub(amount);
}
```

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-missing-authwit` |
| Target | `{path audited}` |
| Files Scanned | `{number}` |
| Findings | `{e.g., "1 Critical, 2 Medium" or "None"}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `missing-authwit-{contract}-{function}-{line}`
- **Severity**: Critical (value transfer) / High (ownership change) / Medium (state modification)
- **File**: `path/to/file.nr:line`
- **Function**: Function name and signature
- **Issue**: What operation is unprotected
- **Fix**: Add `#[authorize_once("param", "nonce")]` or manual check

### JSON Output
Write to specified output directory as `aztec-nr-audit-missing-authwit.json`:
```json
{
  "skill": "aztec-nr-audit-missing-authwit",
  "status": "COMPLETED_WITH_FINDINGS",
  "findings": [
    {
      "id": "missing-authwit-token-transfer-150",
      "severity": "critical",
      "file": "noir-contracts/contracts/token_contract/src/main.nr",
      "line": 150,
      "function": "transfer(from: AztecAddress, to: AztecAddress, amount: Field)",
      "description": "Transfer function allows moving tokens from any address without authorization",
      "exploitability": "high",
      "fix": "Add #[authorize_once(\"from\", \"nonce\")] attribute"
    }
  ]
}
```
