window.BENCHMARK_DATA = {
  "lastUpdate": 1769850374859,
  "repoUrl": "https://github.com/AztecProtocol/aztec-packages",
  "entries": {
    "Aztec Benchmarks": [
      {
        "commit": {
          "author": {
            "name": "AztecProtocol",
            "username": "AztecProtocol"
          },
          "committer": {
            "name": "AztecProtocol",
            "username": "AztecProtocol"
          },
          "id": "2c3e7c7e02267f9ad30e8f23d49aee6a5a9cf04f",
          "message": "fix: nightly spartan benchmarks",
          "timestamp": "2025-12-19T17:19:18Z",
          "url": "https://github.com/AztecProtocol/aztec-packages/pull/19140/commits/2c3e7c7e02267f9ad30e8f23d49aee6a5a9cf04f"
        },
        "date": 1766168595629,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 569,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 144,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/rollup_contracts",
            "value": 64,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/aztec_infra",
            "value": 239,
            "unit": "seconds"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "60546371+PhilWindle@users.noreply.github.com",
            "name": "PhilWindle",
            "username": "PhilWindle"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "65ce9a892b36ead97c0a4c89f8947a64c6894e52",
          "message": "fix(archiver): sync proper txs from blob data (#20091)\n\nWhen syncing from L1 blob data, we were using the txs from the first\nblock for all blocks. This didn't pop up earlier because tests either\nstill work in single block per slot, or don't use txs, or reexecute so\nthey don't need to sync from L1.\n\nAlso adds an extra step to the epochs-mbps test to have a non-validator\nnode sync the slots from L1 from scratch, which was helpful in\nreproducing the issue.",
          "timestamp": "2026-01-30T22:40:31Z",
          "tree_id": "076f4287772e4b1aa0909a8d6783760b182ca421",
          "url": "https://github.com/AztecProtocol/aztec-packages/commit/65ce9a892b36ead97c0a4c89f8947a64c6894e52"
        },
        "date": 1769850283995,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 382,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 85,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/rollup_contracts",
            "value": 54,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/aztec_infra",
            "value": 123,
            "unit": "seconds"
          }
        ]
      }
    ]
  }
}