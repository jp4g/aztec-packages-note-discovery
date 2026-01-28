---
title: Fees
sidebar_position: 4
tags: [fees, mana, gas]
description: Understand Aztec's fee system including mana-based transaction pricing, Aztec token and Fee Juice payments, and how L1 and L2 costs are transparently calculated for users.
references: ["yarn-project/stdlib/src/gas/gas_settings.ts"]
---

import { Why_Fees } from '@site/src/components/Snippets/general_snippets';

<Why_Fees />

In a nutshell, the pricing of transactions transparently accounts for:

- L1 costs, including L1 execution of a block, and data availability via blobs,
- L2 node operating costs, including proving

This is achieved through multiple variables and calculations.

## Terminology

Familiar terms from Ethereum mainnet as referred to on the Aztec network:

| Ethereum Mainnet | Aztec              | Description                                                    |
| ---------------- | ------------------ | -------------------------------------------------------------- |
| gas              | mana               | unit measuring computational effort for transaction operations |
| fee per gas      | Fee Juice per mana | price per unit of mana                                         |
| fee (wei)        | Fee Juice          | total fee paid for a transaction                               |

## What is mana?

Mana is Aztec's unit of computational effort, equivalent to gas on Ethereum. Every transaction consumes mana based on the operations it performs.

Mana has two dimensions:

- **DA (Data Availability) mana**: Cost of publishing transaction data to the data availability layer
- **L2 mana**: Cost of executing the transaction on the Aztec network

The total transaction fee is calculated as:

```
fee = (daGas × feePerDaGas) + (l2Gas × feePerL2Gas)
```

## What is Fee Juice?

Fee Juice is the native fee token on Aztec, used to pay for transaction fees. It is bridged Aztec tokens from L1 and is **non-transferable** on L2 - it can only be used to pay fees, not sent between accounts.

:::note
Fee Juice is sometimes referred to as "Aztec token" in protocol documentation. They are the same thing.
:::

Aztec borrows ideas from EIP-1559, including congestion multipliers and the ability to specify base and priority fees per mana.

## Factors affecting fees

Other fields used in mana and fee calculations are determined in various ways:

- hard-coded constants (eg congestion update fraction)
- values assumed constant (eg L1 gas cost of publishing a block, blobs per block)
- informed from previous block header and/or L1 rollup contract (eg base fee per mana)
- informed via an oracle (eg wei per mana)

Most constants are defined by the protocol, while others are part of the rollup contract on L1.

### User-defined settings

Users can define the following settings as part of a transaction:

import { Gas_Settings_Components, Gas_Settings, Tx_Teardown_Phase } from '@site/src/components/Snippets/general_snippets';

#include_code gas_settings_vars yarn-project/stdlib/src/gas/gas_settings.ts javascript

<Gas_Settings_Components />

## Fee payment

A fee payer will have Fee Juice from bridging Aztec tokens from Ethereum (L1). On Aztec this fee asset is non-transferable, and only deducted by the protocol to pay for fees. A user can claim bridged Fee Juice and use it to pay for transaction fees in the same transaction.

The mechanism for bridging is the same as any other token. For more on this concept see the [Token Bridge Tutorial](../tutorials/js_tutorials/token_bridge.md) which describes portal contracts and [cross-chain messaging](../aztec-nr/framework-description/how_to_communicate_cross_chain.md).

### Payment methods

An account with Fee Juice can pay for its transactions directly, including deployment of a new account, if Fee Juice has been bridged to the address where the account will be deployed.

Alternatively, accounts can use fee-paying contracts (FPCs) to pay for transactions. FPCs accept tokens and pay fees in Fee Juice on behalf of users. Common patterns include:

- **Sponsored FPCs**: Pay fees unconditionally, enabling free transactions for users
- **Token-accepting FPCs**: Accept a specific token in exchange for paying fees

FPCs can contain arbitrary logic to authorize fee payments and can operate privately or publicly.

### Teardown phase

<Tx_Teardown_Phase />

This enables FPCs to calculate the actual transaction cost and refund any overpayment to the user.

### Operator rewards

The calculated fee of a transaction is deducted from the fee payer (nominated account or fee-paying contract), then pooled together across transactions, blocks, and epochs. Once an epoch is proven, the total collected fees (minus any burnt congestion amount) are distributed to the provers and block proposers that contributed to the epoch.

## Next steps

For a guide on paying fees programmatically, see [How to Pay Fees](../aztec-js/how_to_pay_fees).
