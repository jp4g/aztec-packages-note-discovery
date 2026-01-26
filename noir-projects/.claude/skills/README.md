# Aztec-NR Security Audit Skills

Targeted audit skills for finding vulnerabilities in the **aztec-nr framework** and dangerous feature interaction patterns.

## Audit Scope

**Primary target**: `noir-projects/aztec-nr/` - the entire framework
- `aztec/` - Core framework (contexts, state_vars, notes, authwit, macros, oracles, etc.)
- `address-note/` - AztecAddress note implementation
- `balance-set/` - Balance tracking utilities
- `field-note/` - Field value note implementation
- `uint-note/` - u128 value note implementation

**Secondary**: `noir-projects/noir-contracts/` - Example contracts (useful for finding framework misuse patterns)

## Active Skills

| Skill | Focus | Target |
|-------|-------|--------|
| `aztec-nr-audit-feature-interactions` | Dangerous combinations of framework features | Framework |
| `aztec-nr-audit-missing-authwit` | Missing authorization checks | Framework + Contracts |
| `aztec-nr-audit-unsafe-oracle-usage` | Oracle results used without validation | Framework |
| `aztec-nr-audit-note-nullifier-safety` | Weak nullifier computation | Framework |
| `aztec-nr-audit-unconstrained-values` | Witness values not properly constrained | Framework |
| `aztec-nr-audit-initialization-safety` | Unsafe initialization patterns | Framework |

## Usage

```bash
# Run on entire aztec-nr
claude -p "Run /aztec-nr-audit-feature-interactions on noir-projects/aztec-nr/"

# Run on specific module
claude -p "Run /aztec-nr-audit-unsafe-oracle-usage on noir-projects/aztec-nr/aztec/src/oracle/"
```

---

## Vulnerability Taxonomy

### Category 1: Framework Implementation Bugs

Bugs in aztec-nr itself that affect all contracts using it.

| Area | Description | Key Paths |
|------|-------------|-----------|
| **State Variables** | Underconstrainedness in PrivateMutable, PrivateSet, etc. | `aztec/src/state_vars/` |
| **Note Lifecycle** | Bugs in note creation, retrieval, nullification | `aztec/src/note/` |
| **Standard Notes** | Bugs in field-note, uint-note, address-note, balance-set | `*/src/` |
| **Context Management** | Side effect ordering, phase tracking, call stack | `aztec/src/context/` |
| **AuthWit Implementation** | Message hash computation, replay prevention | `aztec/src/authwit/` |
| **Macro Code Generation** | Incorrect code injection, missing checks | `aztec/src/macros/` |
| **Oracle Wrappers** | Framework oracle calls that don't validate properly | `aztec/src/oracle/` |
| **History Proofs** | Merkle proof verification bugs | `aztec/src/history/` |

### Category 2: Feature Interaction Bugs

Emergent issues when framework features combine unexpectedly.

| Interaction | Potential Issue |
|-------------|-----------------|
| `#[initializer]` + `#[authorize_once]` | Auth check before init nullifier exists? |
| `#[nophasecheck]` + state operations | Phase-dependent ops in wrong phase |
| `#[only_self]` + enqueued public calls | Self-call from different execution context |
| `#[view]` + note operations | Static call attempting note side effects |
| Nested private calls + authwit | Auth consumed in wrong call context |
| PrivateSet + multiple inserters | Ownership confusion on inserted notes |
| PrivateMutable + partial notes | Incomplete note state |
| balance-set + concurrent modifications | Race conditions in balance tracking |

### Category 3: Protocol Boundary Issues

Mismatches between app circuit outputs and kernel expectations.

| Issue | Description |
|-------|-------------|
| **Type Mismatches** | aztec-nr types don't match protocol_types |
| **Validation Gaps** | Values app circuit doesn't constrain that kernel expects |
| **Ordering Assumptions** | Side effect counter expectations |

### Category 4: Developer Footguns

Framework designs that make it easy for users to introduce bugs.

| Pattern | Risk |
|---------|------|
| Storage field ordering | Reorder = data corruption |
| Attribute ordering | `#[authorize_once]` must precede `#[external]` |
| Generic selectors | Same selector for different instantiations |
| Zero deployer | Anyone can initialize |

---

## Future Skill Ideas

### High Priority (Framework-Focused)
- `aztec-nr-audit-state-var-constraints` - Audit state variable implementations
- `aztec-nr-audit-context-side-effects` - Audit context side effect handling
- `aztec-nr-audit-macro-codegen` - Audit macro code generation correctness
- `aztec-nr-audit-kernel-boundary` - Audit app↔kernel type compatibility
- `aztec-nr-audit-standard-notes` - Audit field-note, uint-note, address-note, balance-set

### Medium Priority
- `aztec-nr-audit-storage-slot-collision` - Detect storage slot conflicts
- `aztec-nr-audit-phase-boundary` - Find phase violation risks
- `aztec-nr-audit-history-proofs` - Audit merkle proof verification

### Research-Oriented
- `aztec-nr-audit-cryptographic-assumptions` - Verify crypto primitive usage
