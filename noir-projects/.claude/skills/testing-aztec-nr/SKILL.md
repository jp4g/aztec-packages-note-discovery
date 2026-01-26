---
name: testing-aztec-nr
description: Run aztec-nr Noir tests with optional filtering. Use when the user wants to run tests in aztec-nr, test specific functionality, or debug test failures. Supports running all tests or filtering to specific test names.
---

# Testing aztec-nr

## Quick Start

Run all tests:
```bash
cd noir-projects/aztec-nr && ./bootstrap.sh test
```

Run a specific test by name filter:
```bash
cd noir-projects/aztec-nr && ./bootstrap.sh test <filter>
```

Example:
```bash
cd noir-projects/aztec-nr && ./bootstrap.sh test view_discovered_at_other_contract
```

## How It Works

The bootstrap script:
1. Starts a TXE (Test eXecution Environment) server on port 45730
2. Lists all tests via `nargo test --list-tests`
3. When a filter is provided, runs matching tests directly with verbose output
4. When no filter is provided, runs all tests in parallel via `parallelize`

## Finding Test Names

List all available tests:
```bash
cd noir-projects/aztec-nr && $NARGO test --list-tests --silence-warnings | sort
```

Search for tests by keyword:
```bash
cd noir-projects/aztec-nr && $NARGO test --list-tests --silence-warnings | grep -i "<keyword>"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NARGO` | `../../noir/noir-repo/target/release/nargo` | Path to nargo binary |
| `RAYON_NUM_THREADS` | `16` | Parallelism for nargo |
| `NARGO_FOREIGN_CALL_TIMEOUT` | `300000` | Timeout for oracle calls (ms) |

## Test Output

**Filtered tests** (single test or small set): Full verbose output from nargo showing test execution details.

**All tests** (no filter): Parallel execution with progress bar. Failed test output is dumped on failure.

## Troubleshooting

### TXE Server Issues
If tests hang waiting for TXE:
```bash
# Check if TXE is running
nc -z 127.0.0.1 45730 && echo "TXE running" || echo "TXE not running"

# Kill any stale TXE processes
pkill -f "TXE_PORT=45730"
```

### Test Timeouts
Increase the foreign call timeout:
```bash
export NARGO_FOREIGN_CALL_TIMEOUT=600000
cd noir-projects/aztec-nr && ./bootstrap.sh test <filter>
```

## Related Commands

Check aztec-nr for warnings (no tests):
```bash
cd noir-projects/aztec-nr && ./bootstrap.sh
```

Format aztec-nr code:
```bash
cd noir-projects/aztec-nr && ./bootstrap.sh format
```
