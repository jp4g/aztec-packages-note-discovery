---
name: aztec-nr-audit-initialization-safety
description: Audit Aztec contracts for unsafe initialization patterns. Finds contracts where functions can be called before initialization, where #[noinitcheck] exposes uninitialized state, or where zero deployer allows unauthorized initialization.
---

# Initialization Safety Audit

## Purpose
Find contracts vulnerable to initialization-related attacks: pre-init function calls, uninitialized state access, and initialization hijacking.

## Background

Aztec contracts use `#[initializer]` to mark one-time setup functions. The framework:
1. Emits an initialization nullifier when `#[initializer]` completes
2. Checks for this nullifier before other functions (unless `#[noinitcheck]`)
3. Validates deployer can call initializer (unless deployer is zero)

**Known Issue**: Public initialization check is unsafe (F-239) - public functions may be callable before init completes.

## Vulnerability Patterns

### Pattern 1: `#[noinitcheck]` Exposing Uninitialized State
```noir
// VULNERABLE: Can be called before init
#[noinitcheck]
#[external("private")]
fn dangerous_before_init() {
    let owner = storage.owner.read();  // owner may be zero/garbage
    assert(self.msg_sender() == owner);  // Always fails or wrong owner
}
```

### Pattern 2: Zero Deployer Allows Hijacking
```noir
// VULNERABLE: Anyone can initialize if deployer == 0
#[initializer]
#[external("private")]
fn initialize(admin: AztecAddress) {
    storage.admin.write(admin);  // Attacker sets themselves as admin
}
// If deployed with deployer = AztecAddress::zero(), anyone can call
```

### Pattern 3: Public Functions Before Init
```noir
// POTENTIALLY VULNERABLE: Public init check is unsafe (F-239)
#[external("public")]
fn public_withdraw(amount: Field) {
    // May execute before private initializer completes
    let owner = storage.owner.read();
    // ...
}
```

## Workflow

### Step 1: Find Initializers
```bash
# Find initializer functions
grep -rn "#\[initializer\]" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 2: Find noinitcheck Usage
```bash
# Find functions that skip init check
grep -rn "#\[noinitcheck\]" noir-projects/noir-contracts/ --include="*.nr"

# Get context around each
grep -B2 -A10 "#\[noinitcheck\]" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 3: Analyze noinitcheck Functions
For each `#[noinitcheck]` function:
1. Does it read storage that's set in initializer?
2. What happens if that storage is uninitialized (zero)?
3. Could this be exploited?

### Step 4: Check Deployer Constraints
Look at how contracts are deployed:
```bash
# Find deployment patterns
grep -rn "deploy\|ContractInstance\|deployer" noir-projects/noir-contracts/ --include="*.nr"
```

If deployer can be zero, anyone can initialize.

### Step 5: Identify Public Function Risks
```bash
# Find public functions in contracts with initializers
grep -rn '#\[external("public")\]' noir-projects/noir-contracts/ --include="*.nr"
```

For each, check if it:
- Reads state set by initializer
- Has security implications if called pre-init
- Is protected by other means

### Step 6: Check Init-Dependent Logic
```bash
# Find storage reads that might be uninitialized
grep -rn "storage\.\w*\.read\|storage\.\w*\.get" noir-projects/noir-contracts/ --include="*.nr"
```

Cross-reference with initializer to see what's set there.

## False Positive Patterns

### Intentional Pre-Init Functions (Document)
```noir
// Some functions legitimately work before init
#[noinitcheck]
#[external("private")]
fn deposit() {
    // Deposits work before owner is set
    // Documented and intentional
}
```

### View Functions (Lower Risk)
```noir
#[noinitcheck]
#[view]
fn get_status() -> Field {
    // Read-only, returns zero if uninitialized
    // May be confusing but not exploitable
}
```

### Upgrade Patterns (Document)
```noir
#[noinitcheck]
#[external("private")]
fn migrate_v2() {
    // Intentionally callable to upgrade
    assert(storage.version.read() == 1);
}
```

## Example Findings

### Critical: Admin Bypass via Pre-Init Call
```noir
// governance.nr:50
#[noinitcheck]
#[external("private")]
fn execute_proposal(proposal_id: Field) {
    // CRITICAL: Can execute before admin is set
    let admin = storage.admin.read();  // Zero before init
    // ... admin checks may pass or be bypassed
}
```

### High: Zero Deployer Initialization Hijack
```noir
// vault.nr:30
// Contract deployed with deployer = AztecAddress::zero()
#[initializer]
#[external("private")]
fn initialize(owner: AztecAddress, fee_recipient: AztecAddress) {
    // HIGH: Anyone can call this and set themselves as owner
    storage.owner.write(owner);
    storage.fee_recipient.write(fee_recipient);
}
```

### Medium: Public Function Pre-Init (F-239)
```noir
// token.nr:100
#[external("public")]
fn mint(to: AztecAddress, amount: Field) {
    // MEDIUM: May be callable before init due to F-239
    let minter = storage.minter.read();
    assert(self.msg_sender() == minter);  // minter could be zero
}
```

### Low: Confusing Pre-Init Behavior
```noir
// registry.nr:80
#[noinitcheck]
#[view]
fn get_owner() -> AztecAddress {
    // LOW: Returns zero before init, may confuse users
    storage.owner.read()
}
```

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-initialization-safety` |
| Target | `{path audited}` |
| Contracts with Initializers | `{number}` |
| noinitcheck Functions | `{number}` |
| Findings | `{e.g., "1 High, 2 Medium" or "None"}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `init-safety-{contract}-{issue-type}-{line}`
- **Severity**: Critical / High / Medium / Low
- **File**: `path/to/file.nr:line`
- **Issue Type**: `noinitcheck-exposure` / `zero-deployer` / `public-pre-init`
- **Description**: What can go wrong
- **Fix**: Remove noinitcheck, require deployer, or add manual check

### JSON Output
Write to `aztec-nr-audit-initialization-safety.json`:
```json
{
  "skill": "aztec-nr-audit-initialization-safety",
  "status": "COMPLETED_WITH_FINDINGS",
  "findings": [
    {
      "id": "init-safety-governance-noinitcheck-50",
      "severity": "critical",
      "file": "noir-contracts/contracts/governance/src/main.nr",
      "line": 50,
      "issue_type": "noinitcheck-exposure",
      "description": "execute_proposal can be called before admin is set, bypassing governance",
      "exploitability": "high",
      "fix": "Remove #[noinitcheck] or add explicit admin validation"
    }
  ]
}
```

## Additional Notes

### F-239 Tracking
The public initialization check is known unsafe. Track resolution of F-239 for:
- `assert_is_initialized_public` in `initialization_utils.nr`
- `nullifier_exists_unsafe` usage

### Testing Initialization
When reviewing, consider:
1. What's the deployment flow?
2. Who can deploy (permissionless or controlled)?
3. What happens in the time between deployment and initialization?
4. Are there front-running risks on initialization?
