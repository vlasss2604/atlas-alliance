import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeExchangeEvent,
  decodeVenueSwap,
  deriveDecodedExchange,
  EXCHANGE_DOES_NOT_PROVE,
  __derivation,
} from "../src/server/engine/onchain-exchange-decoding";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { deriveReciprocalAssetFlows } from "../src/server/engine/onchain-transaction-flow";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  RawInstructionRef,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// DECODING A BLOB WITHOUT A VENDORED CONTRACT.
//
// The fixture is the normalized_result of onchain_artifacts row
// bff0290c-2d5e-4b33-a518-5efaece12338, the owner-authorized re-read of
// the transaction at slot 441840975, copied verbatim from the local
// database. It is the first artifact carrying rawInstructions, which is
// what makes any of this readable at all.
//
// WHAT MAKES THIS DETERMINISTIC RATHER THAN RECALLED. An Anchor program
// dispatches on sha256("global:<method>")[0..8]. A method name is
// therefore a hypothesis that either reproduces the observed eight bytes
// exactly or is wrong, and the check runs here, locally, on the real
// bytes. That the venue method is swap_v2 does not depend on remembering
// a layout, on any IDL, or even on the owner-supplied program identities —
// a different program with that discriminator would still be answering to
// that method name.
//
// The event is read the same way: its own NAME is not established and is
// deliberately never asserted, only its discriminator bytes. Its payload
// is read as a tiling the total length forces, and every field the tiling
// produces is then checked against something this transaction states
// independently — two mints that base58-match known addresses, and two
// amounts that equal real transfers.
//
// WHAT IS NOT CLAIMED ANYWHERE BELOW: buyback, revenue, policy, market
// price, or that anything comparable happens routinely. An exchange is an
// exchange.

const ANCHOR = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL = "So11111111111111111111111111111111111111112";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const CAMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const A = "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c";
const C = "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5";
const A_WRAPPER = "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn";
const A_PUMP = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const C_WSOL = "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6";
const C_PUMP = "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK";
const SIGNATURE =
  "4eMRNdmcsvxG86g7KqfQHFNivueW1BHnY5Qut6WkTkX2zGL2E4EQEkGH2vB8b7vtamc6xa5E4Wi1BCnzUteQCwXR";
const WSOL_PAID = "382202589";
const PUMP_RECEIVED = "7723746661";

// Copied verbatim from onchain_artifacts.normalized_result for row
// bff0290c-2d5e-4b33-a518-5efaece12338. Inlined so the regression case
// travels with the repository rather than depending on a local database.
const PERSISTED = {
  "kind": "TRANSACTION_DETAIL",
  "slot": 441840975,
  "burns": [],
  "programs": [
    "ComputeBudget111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ],
  "blockTime": 1787737824,
  "signature": "4eMRNdmcsvxG86g7KqfQHFNivueW1BHnY5Qut6WkTkX2zGL2E4EQEkGH2vB8b7vtamc6xa5E4Wi1BCnzUteQCwXR",
  "succeeded": true,
  "accountKeys": [
    "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
    "5ZR64p563NQa3Wf451GpXUYdpfc1775mp3RbMoiswwdD",
    "6EpVJ7VjE72MjhQyuiURGNUn2wUPDduhjM8dhMxdwdD3",
    "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
    "CWePFh3uUZDVBwTNXctYo9MbnMJQSk5vq3Q24hoJPfkh",
    "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
    "11111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk",
    "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
    "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
    "7oVcrScfu1jVKq1DsaVZ8HtX1RZ6sa3oik3uVhowtifK",
    "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
    "GFHU8GNWeYKpLuTvfAJbeVHFiafBVZZwfCbD16NC9Y9t",
    "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
    "jitodontfront1111111111111111JustUseJupiter",
    "So11111111111111111111111111111111111111112",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
  ],
  "rawInstructions": [
    {
      "data": "KBvEJj",
      "inner": false,
      "accounts": [],
      "programId": "ComputeBudget111111111111111111111111111111",
      "parentIndex": null,
      "instructionIndex": 0
    },
    {
      "data": "3YY7SxtuFyRZ",
      "inner": false,
      "accounts": [],
      "programId": "ComputeBudget111111111111111111111111111111",
      "parentIndex": null,
      "instructionIndex": 1
    },
    {
      "data": "37MZM8vwf4KFGSGFY8LuHtj3UWBaSC5VW5ADTrmzmEuCE9qeWoj7Qc",
      "inner": false,
      "accounts": [
        "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
        "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
        "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
        "So11111111111111111111111111111111111111112",
        "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk",
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
        "DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY",
        "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
        "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
        "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
        "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
        "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
        "7oVcrScfu1jVKq1DsaVZ8HtX1RZ6sa3oik3uVhowtifK",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "So11111111111111111111111111111111111111112",
        "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
        "GFHU8GNWeYKpLuTvfAJbeVHFiafBVZZwfCbD16NC9Y9t",
        "5ZR64p563NQa3Wf451GpXUYdpfc1775mp3RbMoiswwdD",
        "CWePFh3uUZDVBwTNXctYo9MbnMJQSk5vq3Q24hoJPfkh",
        "6EpVJ7VjE72MjhQyuiURGNUn2wUPDduhjM8dhMxdwdD3",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "jitodontfront1111111111111111JustUseJupiter"
      ],
      "programId": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      "parentIndex": null,
      "instructionIndex": 5
    },
    {
      "data": "ASCsAbe1UnEuceqWhmLKGKHuJePysYd3iqgnZ2GnkzJFijELbrw4L9D2",
      "inner": true,
      "accounts": [
        "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
        "DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY",
        "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
        "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
        "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
        "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
        "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
        "7oVcrScfu1jVKq1DsaVZ8HtX1RZ6sa3oik3uVhowtifK",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "So11111111111111111111111111111111111111112",
        "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
        "GFHU8GNWeYKpLuTvfAJbeVHFiafBVZZwfCbD16NC9Y9t",
        "5ZR64p563NQa3Wf451GpXUYdpfc1775mp3RbMoiswwdD",
        "CWePFh3uUZDVBwTNXctYo9MbnMJQSk5vq3Q24hoJPfkh",
        "6EpVJ7VjE72MjhQyuiURGNUn2wUPDduhjM8dhMxdwdD3"
      ],
      "programId": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      "parentIndex": 5,
      "instructionIndex": 0
    },
    {
      "data": "3drYVtAcBYiMtM5fDAD2VT79gAoN6vD18v9Jn7pH7sLP26vfth5Vxkahuq6cwH9UADUkYXffgLVKPCQYS9X2cK9bECPfLaDKDPeiFzFRhZsTfFmsUUJDBfQnnZtyaUP1RBYn3iLGABuPPr6ywfeGyhWJHZczHDtPfu8hgDrPAbzuBRooHS1zD",
      "inner": true,
      "accounts": [
        "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
      ],
      "programId": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      "parentIndex": 5,
      "instructionIndex": 3
    }
  ],
  "preTokenBalances": [
    {
      "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      "owner": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "account": "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
      "decimals": 6,
      "amountRaw": "0",
      "accountIndex": 3
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "owner": "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE",
      "account": "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk",
      "decimals": 9,
      "amountRaw": "1035310248",
      "accountIndex": 11
    },
    {
      "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      "owner": "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
      "account": "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
      "decimals": 6,
      "amountRaw": "97621058034968",
      "accountIndex": 13
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "owner": "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
      "account": "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
      "decimals": 9,
      "amountRaw": "6099621274382",
      "accountIndex": 15
    }
  ],
  "postTokenBalances": [
    {
      "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      "owner": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "account": "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
      "decimals": 6,
      "amountRaw": "7723746661",
      "accountIndex": 3
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "owner": "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE",
      "account": "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk",
      "decimals": 9,
      "amountRaw": "1035692833",
      "accountIndex": 11
    },
    {
      "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      "owner": "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
      "account": "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
      "decimals": 6,
      "amountRaw": "97613334288307",
      "accountIndex": 13
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "owner": "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
      "account": "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
      "decimals": 9,
      "amountRaw": "6100003476971",
      "accountIndex": 15
    }
  ],
  "tokenInstructions": [
    {
      "mint": null,
      "type": "closeAccount",
      "inner": false,
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "decimals": null,
      "amountRaw": null,
      "authority": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "destination": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "parentIndex": null,
      "instructionIndex": 6
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "type": "transferChecked",
      "inner": true,
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "decimals": 9,
      "amountRaw": "382202589",
      "authority": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "destination": "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6",
      "parentIndex": 5,
      "instructionIndex": 1
    },
    {
      "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      "type": "transferChecked",
      "inner": true,
      "account": "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK",
      "decimals": 6,
      "amountRaw": "7723746661",
      "authority": "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
      "programId": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "destination": "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
      "parentIndex": 5,
      "instructionIndex": 2
    },
    {
      "mint": null,
      "type": "transfer",
      "inner": true,
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "decimals": null,
      "amountRaw": "382585",
      "authority": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "destination": "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk",
      "parentIndex": 5,
      "instructionIndex": 4
    }
  ],
  "lifecycleInstructions": [
    {
      "mint": "So11111111111111111111111111111111111111112",
      "type": "createIdempotent",
      "inner": false,
      "owner": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "payer": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "source": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "lamports": null,
      "programId": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "destination": null,
      "parentIndex": null,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "assignedProgram": null,
      "instructionIndex": 2
    },
    {
      "mint": null,
      "type": "transfer",
      "inner": false,
      "owner": null,
      "payer": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "source": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "account": null,
      "lamports": "382585174",
      "programId": "11111111111111111111111111111111",
      "destination": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "parentIndex": null,
      "tokenProgram": null,
      "assignedProgram": null,
      "instructionIndex": 3
    },
    {
      "mint": null,
      "type": "syncNative",
      "inner": false,
      "owner": null,
      "payer": null,
      "source": null,
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "lamports": null,
      "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "destination": null,
      "parentIndex": null,
      "tokenProgram": null,
      "assignedProgram": null,
      "instructionIndex": 4
    },
    {
      "mint": null,
      "type": "createAccount",
      "inner": true,
      "owner": null,
      "payer": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "source": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "lamports": "2039280",
      "programId": "11111111111111111111111111111111",
      "destination": null,
      "parentIndex": 2,
      "tokenProgram": null,
      "assignedProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "instructionIndex": 1
    },
    {
      "mint": "So11111111111111111111111111111111111111112",
      "type": "initializeAccount3",
      "inner": true,
      "owner": "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c",
      "payer": null,
      "source": null,
      "account": "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn",
      "lamports": null,
      "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "destination": null,
      "parentIndex": 2,
      "tokenProgram": null,
      "assignedProgram": null,
      "instructionIndex": 3
    }
  ]
} as unknown as TransactionDetailResult;

function persisted(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return { ...(JSON.parse(JSON.stringify(PERSISTED)) as TransactionDetailResult), ...over };
}

function rawOf(r: TransactionDetailResult, programId: string, bytes: number): RawInstructionRef {
  const found = (r.rawInstructions ?? []).find(
    (x) => x.programId === programId && x.data.length > 0 && decodedLength(x.data) === bytes,
  );
  if (!found) throw new Error(`no raw instruction for ${programId} of ${bytes} bytes`);
  return found;
}
function decodedLength(data: string): number {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(0);
  for (const ch of data) n = n * BigInt(58) + BigInt(B58.indexOf(ch));
  let len = 0;
  while (n > BigInt(0)) {
    len += 1;
    n >>= BigInt(8);
  }
  for (const ch of data) {
    if (ch === "1") len += 1;
    else break;
  }
  return len;
}

function artifact(result: TransactionDetailResult): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: ANCHOR,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${ANCHOR}/tx/${SIGNATURE}/detail`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "tx",
      subject: SIGNATURE,
      slot: 441_840_975,
      blockTime: 1_787_737_824,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      retrievedAt: new Date("2026-08-27T13:12:29.658Z"),
      rawResponseHash: "sha256:686ba894aaabfd9f47ce709b9a75f9e5db7bbf918b102652c370ec84c8f81212",
      artifactHash: "sha256:4b94e0832e4a2e1db1a03f9f03567f3d446717928e0324c8073254ae74fb903f",
      transactionSignature: SIGNATURE,
    },
  });
}

const factsFor = (r: TransactionDetailResult) =>
  synthesizeOnchainFacts(artifact(r), { step: 2, component: "FLOW_PATH" });

describe("0. the constants are derived here, not pasted in", () => {
  it("the venue discriminator is sha256 of the method name", () => {
    const computed = createHash("sha256").update("global:swap_v2").digest().subarray(0, 8).toString("hex");
    expect(__derivation.swapV2Discriminator).toBe(computed);
  });

  it("the event-CPI marker is derived from anchor:event", () => {
    const digest = createHash("sha256").update("anchor:event").digest().subarray(0, 8);
    expect(__derivation.eventCpiMarker).toBe(Buffer.from([...digest].reverse()).toString("hex"));
  });
});

describe("1. the venue instruction: swap_v2, decoded from the real blob", () => {
  const venue = decodeVenueSwap(rawOf(persisted(), CAMM, 41));

  it("decodes, and its amount is the wSOL that actually moved", () => {
    expect(venue).not.toBeNull();
    expect(venue!.amountRaw).toBe(WSOL_PAID);
  });

  it("it is a CPI of the outer instruction the other legs belong to", () => {
    expect(venue!.parentIndex).toBe(5);
  });
});

describe("2. the aggregator instruction: an event, named only by its bytes", () => {
  const event = decodeExchangeEvent(rawOf(persisted(), JUP, 132));

  it("decodes as an event CPI", () => {
    expect(event).not.toBeNull();
    expect(event!.parentIndex).toBe(5);
  });

  it("its NAME is not asserted — only the discriminator is reported", () => {
    // Deliberate: no tested event name reproduced these bytes, so calling
    // it SwapEvent or anything else would be inventing a schema.
    expect(event!.discriminatorHex).toBe("982f4eebc0606e6a");
  });

  it("its payload states both mints and both realized amounts", () => {
    expect(event!.assets).toEqual([
      { mint: WSOL, amountRaw: WSOL_PAID },
      { mint: ANCHOR, amountRaw: PUMP_RECEIVED },
    ]);
  });

  it("the OUTER aggregator instruction is not decoded — its variant is unknown", () => {
    // 39 bytes, discriminator bb64facc31c4af14, matching no tested method.
    // Unsupported is the honest answer, and nothing depends on it.
    const outer = rawOf(persisted(), JUP, 39);
    expect(outer.inner).toBe(false);
    expect(decodeExchangeEvent(outer)).toBeNull();
    expect(decodeVenueSwap(outer)).toBeNull();
  });
});

describe("3. account roles, established without using account order", () => {
  const x = deriveDecodedExchange(persisted(), ANCHOR)!;

  it("an exchange is derived from the real persisted transaction", () => {
    expect(x).not.toBeNull();
    expect(x.signature).toBe(SIGNATURE);
    expect(x.slot).toBe(441_840_975);
    expect(x.invocationIndex).toBe(5);
  });

  it("the documented address pays wSOL and receives the project token", () => {
    expect(x.participant).toBe(A);
    expect(x.counterparty).toBe(C);
    expect(x.paid).toEqual({
      mint: WSOL,
      amountRaw: WSOL_PAID,
      fromAccount: A_WRAPPER,
      fromOwner: A,
      toAccount: C_WSOL,
      toOwner: C,
    });
    expect(x.received).toEqual({
      mint: ANCHOR,
      amountRaw: PUMP_RECEIVED,
      fromAccount: C_PUMP,
      fromOwner: C,
      toAccount: A_PUMP,
      toOwner: A,
    });
  });

  it("the paying account is the transient wrapper, resolved by attestation", () => {
    // It appears in no balance metadata, so a balance-only reading could
    // never have corroborated the leg that pays.
    for (const b of [...persisted().preTokenBalances, ...persisted().postTokenBalances]) {
      expect(b.account).not.toBe(A_WRAPPER);
    }
    expect(x.paid.fromAccount).toBe(A_WRAPPER);
  });

  it("the roles came from mints and amounts, not from array position", () => {
    // Shuffling the venue instruction's account list changes nothing,
    // because no role was ever read out of it.
    const r = persisted();
    const shuffled = persisted({
      rawInstructions: (r.rawInstructions ?? []).map((ix) =>
        ix.programId === CAMM ? { ...ix, accounts: [...ix.accounts].reverse() } : ix,
      ),
    });
    expect(deriveDecodedExchange(shuffled, ANCHOR)).toEqual(x);
  });
});

describe("4/5/6. failing closed", () => {
  const r = persisted();
  const mapRaw = (fn: (ix: RawInstructionRef) => RawInstructionRef) =>
    persisted({ rawInstructions: (r.rawInstructions ?? []).map(fn) });

  it("4. a corrupted venue discriminator decodes nothing", () => {
    const broken = mapRaw((ix) =>
      ix.programId === CAMM ? { ...ix, data: `1${ix.data.slice(1)}` } : ix,
    );
    expect(deriveDecodedExchange(broken, ANCHOR)).toBeNull();
  });

  it("5. the right discriminator under the wrong program decodes nothing", () => {
    const moved = mapRaw((ix) =>
      ix.programId === CAMM ? { ...ix, programId: JUP } : ix,
    );
    expect(deriveDecodedExchange(moved, ANCHOR)).toBeNull();
    expect(decodeVenueSwap({ ...rawOf(r, CAMM, 41), programId: JUP })).toBeNull();
  });

  it("6. an empty account list on the venue instruction decodes nothing", () => {
    const stripped = mapRaw((ix) => (ix.programId === CAMM ? { ...ix, accounts: [] } : ix));
    expect(deriveDecodedExchange(stripped, ANCHOR)).toBeNull();
  });

  it("6. a truncated event payload decodes nothing", () => {
    const short = mapRaw((ix) =>
      ix.programId === JUP && decodedLength(ix.data) === 132 ? { ...ix, data: ix.data.slice(0, 40) } : ix,
    );
    expect(deriveDecodedExchange(short, ANCHOR)).toBeNull();
  });

  it("venue and event in DIFFERENT invocations decode nothing", () => {
    const split = mapRaw((ix) => (ix.programId === CAMM ? { ...ix, parentIndex: 4 } : ix));
    expect(deriveDecodedExchange(split, ANCHOR)).toBeNull();
  });

  it("an event naming an amount no transfer corroborates decodes nothing", () => {
    const noTransfer = persisted({
      tokenInstructions: r.tokenInstructions.filter((ix) => ix.amountRaw !== PUMP_RECEIVED),
    });
    expect(deriveDecodedExchange(noTransfer, ANCHOR)).toBeNull();
  });

  it("an exchange not involving the project's mint decodes nothing", () => {
    expect(deriveDecodedExchange(persisted(), "MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });

  it("an artifact with no preserved instructions decodes nothing", () => {
    // Absent is not empty: the older artifacts cannot be read this way and
    // must not be treated as carrying no exchange.
    const old = persisted();
    delete (old as { rawInstructions?: unknown }).rawInstructions;
    expect(deriveDecodedExchange(old, ANCHOR)).toBeNull();
  });

  it("a failed transaction decodes nothing", () => {
    expect(deriveDecodedExchange(persisted({ succeeded: false }), ANCHOR)).toBeNull();
  });
});

describe("7/8. nothing else moved", () => {
  it("7. the reciprocal-flow facts are unchanged, and still CONTEXT", () => {
    const flows = deriveReciprocalAssetFlows(persisted(), ANCHOR);
    expect(flows).toHaveLength(1);
    expect(flows[0].participant).toBe(A);
    expect(flows[0].counterparty).toBe(C);
    const facts = factsFor(persisted());
    // Three reciprocal facts, then the exchange fact.
    expect(facts).toHaveLength(4);
    for (const f of facts) {
      expect(f.relationship).toBe("CONTEXT");
      expect(f.directness).toBe("DIRECT");
      expect(f.mechanismState).toBeNull();
    }
  });

  it("8. BurnChecked is untouched — this transaction still has no burn", () => {
    expect(persisted().burns).toHaveLength(0);
    // And a burn-bearing transaction is unaffected by exchange decoding:
    // it carries no venue instruction, so nothing is derived.
    const burnLike = persisted({ rawInstructions: [], burns: [] });
    expect(deriveDecodedExchange(burnLike, ANCHOR)).toBeNull();
  });

  it("the exchange fact establishes no component — CONTEXT, no mechanism state", () => {
    const exchangeFact = factsFor(persisted())[3];
    expect(exchangeFact.relationship).toBe("CONTEXT");
    expect(exchangeFact.mechanismState).toBeNull();
    expect(exchangeFact.statement).toContain("deterministically executes an asset exchange");
    expect(exchangeFact.statement).toContain(WSOL_PAID);
    expect(exchangeFact.statement).toContain(PUMP_RECEIVED);
    expect(exchangeFact.statement).toContain("swap_v2");
  });
});

describe("9. the words that must not appear", () => {
  it("no statement claims a buyback, revenue, policy or market price", () => {
    const facts = factsFor(persisted());
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    for (const forbidden of [
      "buyback", "buy back", "purchase", "bought", "revenue", "policy",
      "market price", "market buy", "mechanism", "burn", "supply", "in exchange for",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("the limits say plainly what an exchange does not settle", () => {
    expect(EXCHANGE_DOES_NOT_PROVE).toContain("does NOT establish that the exchange was a buyback");
    expect(EXCHANGE_DOES_NOT_PROVE).toContain("what funded the asset that was paid");
    expect(EXCHANGE_DOES_NOT_PROVE).toContain("that the price was a market price");
    expect(EXCHANGE_DOES_NOT_PROVE).toContain("It is one exchange");
  });
});
