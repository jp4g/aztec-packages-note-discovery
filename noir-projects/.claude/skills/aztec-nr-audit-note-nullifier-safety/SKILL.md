---
name: aztec-nr-audit-note-nullifier-safety
description: Audit custom note implementations for nullifier collision vulnerabilities. Finds notes where nullifier computation lacks proper domain separation, randomness, or unique inputs, enabling double-spend attacks via nullifier reuse.
---

# Note Nullifier Safety Audit

## Purpose
Find custom note implementations with weak nullifier computation that could allow double-spend via nullifier collision.

## Background

In Aztec's UTXO model, nullifiers prevent double-spending. Each note must produce a **unique nullifier** when spent. If two different notes produce the same nullifier, only one can be spent (silent failure) or both can be double-spent (if collision is intentional).

## Vulnerability Pattern

```noir
// VULNERABLE: Nullifier only depends on note content, not position
impl NoteHash for WeakNote {
    fn compute_nullifier(self, context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
        // WEAK: Only uses note value - two notes with same value = same nullifier
        poseidon2_hash([self.value])
    }
}

// SAFE: Includes note_hash_for_nullify (unique per note position)
impl NoteHash for SafeNote {
    fn compute_nullifier(self, context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
        // STRONG: Includes position-dependent hash
        poseidon2_hash([
            note_hash_for_nullify,  // Unique per note
            self.owner.to_field(),
            context.get_nsk_app(self.npk_m_hash)  // Owner's secret key
        ])
    }
}
```

## Workflow

### Step 1: Find Custom Note Implementations
```bash
# Find NoteHash trait implementations
grep -rn "impl.*NoteHash.*for" noir-projects/noir-contracts/ --include="*.nr"

# Find note struct definitions
grep -rn "#\[note\]" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 2: Analyze Nullifier Computation
For each custom note, find its `compute_nullifier` or `compute_nullifier_unconstrained`:
```bash
grep -A20 "fn compute_nullifier" noir-projects/noir-contracts/ --include="*.nr"
```

### Step 3: Check Nullifier Inputs
A strong nullifier MUST include:
1. **`note_hash_for_nullify`** - Position-dependent, unique per note
2. **Owner's secret key** (`nsk_app`) - Prevents others from computing
3. **Domain separation** - Prevents cross-note-type collision

Check for these patterns:
```bash
# Should see note_hash_for_nullify used
grep -rn "note_hash_for_nullify\|note_hash_for_nullification" \
  noir-projects/noir-contracts/ --include="*.nr"

# Should see nsk_app or nullifier key
grep -rn "get_nsk_app\|nsk_app\|nullifier.*key" \
  noir-projects/noir-contracts/ --include="*.nr"
```

### Step 4: Identify Weak Patterns

**Red flags**:
- Nullifier only uses note fields (no `note_hash_for_nullify`)
- Missing owner's secret key
- No domain separator for note type
- Using `poseidon2_hash` on just `[self.value]`

**Strong pattern** (from framework notes):
```noir
fn compute_nullifier(self, context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
    let secret = context.request_nsk_app(self.npk_m_hash);
    poseidon2_hash_with_separator(
        [note_hash_for_nullify, secret],
        GENERATOR_INDEX__NOTE_NULLIFIER as Field
    )
}
```

### Step 5: Check Standard Notes
Verify contracts use standard note types from aztec-nr:
```bash
# Standard notes (usually safe)
grep -rn "use.*TokenNote\|use.*ValueNote\|use.*AddressNote" \
  noir-projects/noir-contracts/ --include="*.nr"

# Custom note structs (need review)
grep -rn "struct.*Note\|#\[note\]" noir-projects/noir-contracts/ --include="*.nr" | \
  grep -v "TokenNote\|ValueNote\|AddressNote"
```

## False Positive Patterns

### Standard Framework Notes (Safe)
```noir
use dep::aztec::prelude::TokenNote;  // Framework-provided, audited
```

### Properly Implemented Custom Notes (Safe)
```noir
fn compute_nullifier(self, context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
    let nsk = context.request_nsk_app(self.npk_m_hash);
    poseidon2_hash_with_separator(
        [note_hash_for_nullify, nsk, self.custom_field],
        CUSTOM_NOTE_NULLIFIER_DOMAIN
    )
}
```

## Example Findings

### Critical: Nullifier Without Position
```noir
// custom_note.nr:50
impl NoteHash for RewardNote {
    fn compute_nullifier(self, _context: &mut PrivateContext, _note_hash: Field) -> Field {
        // CRITICAL: Ignores note_hash_for_nullify!
        poseidon2_hash([self.amount, self.recipient.to_field()])
    }
}
```
**Impact**: Two RewardNotes with same amount/recipient produce same nullifier.

### High: Missing Secret Key
```noir
// escrow_note.nr:80
impl NoteHash for EscrowNote {
    fn compute_nullifier(self, _context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
        // HIGH: No nsk_app - anyone can compute nullifier
        poseidon2_hash([note_hash_for_nullify, self.owner.to_field()])
    }
}
```
**Impact**: Anyone can compute and potentially front-run nullifier publication.

### Medium: No Domain Separation
```noir
// bidding_note.nr:60
impl NoteHash for BidNote {
    fn compute_nullifier(self, context: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
        // MEDIUM: No domain separator
        let nsk = context.request_nsk_app(self.npk_m_hash);
        poseidon2_hash([note_hash_for_nullify, nsk])  // Missing separator!
    }
}
```
**Impact**: Potential collision with other note types using same pattern.

## Output Format

### Summary Table
| Item | Value |
|------|-------|
| Skill | `aztec-nr-audit-note-nullifier-safety` |
| Target | `{path audited}` |
| Custom Notes Found | `{number}` |
| Findings | `{e.g., "1 Critical, 1 High" or "None"}` |
| Status | `COMPLETED_WITH_FINDINGS` / `COMPLETED_NO_FINDINGS` |

### Each Finding
- **ID**: `nullifier-safety-{contract}-{note-type}-{issue}`
- **Severity**: Critical (collision possible) / High (missing nsk) / Medium (no domain sep)
- **File**: `path/to/file.nr:line`
- **Note Type**: Name of the custom note
- **Issue**: What's missing from nullifier computation
- **Fix**: Include missing component

### JSON Output
Write to `aztec-nr-audit-note-nullifier-safety.json`:
```json
{
  "skill": "aztec-nr-audit-note-nullifier-safety",
  "status": "COMPLETED_WITH_FINDINGS",
  "findings": [
    {
      "id": "nullifier-safety-rewards-RewardNote-no-position",
      "severity": "critical",
      "file": "noir-contracts/contracts/rewards/src/custom_note.nr",
      "line": 50,
      "note_type": "RewardNote",
      "description": "Nullifier computation ignores note_hash_for_nullify parameter",
      "exploitability": "high",
      "fix": "Include note_hash_for_nullify in hash computation"
    }
  ]
}
```
