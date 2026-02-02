window.BENCHMARK_DATA = {
  "lastUpdate": 1770024377329,
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
        "date": 1769853056736,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 399,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 92,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/rollup_contracts",
            "value": 55,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/aztec_infra",
            "value": 120,
            "unit": "seconds"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "janbenes1234@gmail.com",
            "name": "Jan Beneš",
            "username": "benesjan"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d7ec707e6cdedc837d13774179acbde0d36e9810",
          "message": "refactor: improving membership funcs naming (#20065)\n\nAs discussed on slack the naming of the `getArchiveMembershipWitness`\nfunction was not great so I renamed it to\n`getBlockHashMembershipWitness`.\n\nWith that the arg naming became weird so I changed it in all the\nendpoint functions.",
          "timestamp": "2026-01-31T09:18:08Z",
          "tree_id": "587ec6841a0ce8e1722d45b6a493bb562298421d",
          "url": "https://github.com/AztecProtocol/aztec-packages/commit/d7ec707e6cdedc837d13774179acbde0d36e9810"
        },
        "date": 1769938200541,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 431,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 135,
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
      },
      {
        "commit": {
          "author": {
            "email": "janbenes1234@gmail.com",
            "name": "Jan Beneš",
            "username": "benesjan"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d7ec707e6cdedc837d13774179acbde0d36e9810",
          "message": "refactor: improving membership funcs naming (#20065)\n\nAs discussed on slack the naming of the `getArchiveMembershipWitness`\nfunction was not great so I renamed it to\n`getBlockHashMembershipWitness`.\n\nWith that the arg naming became weird so I changed it in all the\nendpoint functions.",
          "timestamp": "2026-01-31T09:18:08Z",
          "tree_id": "587ec6841a0ce8e1722d45b6a493bb562298421d",
          "url": "https://github.com/AztecProtocol/aztec-packages/commit/d7ec707e6cdedc837d13774179acbde0d36e9810"
        },
        "date": 1769939824878,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 429,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 133,
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
      },
      {
        "commit": {
          "author": {
            "email": "tech@aztecprotocol.com",
            "name": "AztecBot"
          },
          "committer": {
            "email": "tech@aztecprotocol.com",
            "name": "AztecBot"
          },
          "distinct": true,
          "id": "0319115d88812d61771a1856448aa8d1c9e9df73",
          "message": "chore(docs): cut new aztec and bb docs version for tag v4.0.0-nightly.20260201",
          "timestamp": "2026-02-01T05:35:46Z",
          "tree_id": "d0eba479de7a4bcdd95a5908a574e3c48c92f45a",
          "url": "https://github.com/AztecProtocol/aztec-packages/commit/0319115d88812d61771a1856448aa8d1c9e9df73"
        },
        "date": 1770024275480,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "spartan/ci/network_deploy/total",
            "value": 372,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/eth_devnet",
            "value": 101,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/rollup_contracts",
            "value": 54,
            "unit": "seconds"
          },
          {
            "name": "spartan/ci/network_deploy/aztec_infra",
            "value": 98,
            "unit": "seconds"
          }
        ]
      }
    ]
  }
}