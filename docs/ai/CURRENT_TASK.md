# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

A provider-only count_tokens probe is prepared. **No live call was made this
round**, no production behavior changed (`src/` untouched), Raydium untouched.

### The probe

`scripts/anthropic-count-tokens-probe.ts` — the model-provider sibling of
`renderer-selftest.ts`. It answers exactly one question: *can the currently
configured Anthropic client execute the same countTokens capability the
EvidenceExtractor uses?* — outside any research process.

Production fidelity, verified from code not memory:

- client constructed exactly as the extractor does:
  `new Anthropic({ apiKey, maxRetries: 0 })`
- model id read from product config (`evidence_extractor_model` — currently
  `claude-haiku-4-5`), never a literal in the probe (pinned by test)
- ceiling from the same `loadModelCostProfile("EVIDENCE_EXTRACTOR", …)`
- the SAME retry composition `countThenGate` uses
  (`retryOnceIfTransient` + `isTransientAnthropicApiError`), so a transient
  failure retries exactly once, like production
- failure output is ONLY the closed diagnostic from `token-gate.ts`
  (`classifyTokenCountFailure`), plus the trusted status integer

`countThenGate` itself returns void, so the probe composes the same exported
primitives to be able to REPORT the count — noted in the script header as a
follow-the-gate obligation. `output_config` is omitted: the probe tests the
capability (endpoint, credential, model id, reachability), not the extractor's
exact schema shape, and says so.

### The command (owner-run, MantaRay ON)

```
npx tsx scripts/anthropic-count-tokens-probe.ts
```

### Maximum live footprint — stated before the run

| axis | max |
|---|---|
| Anthropic countTokens requests | **2** (1 + 1 retry, ONLY if the first failure is transient: 429/5xx/no-response) |
| generation requests | **0** |
| non-Anthropic HTTP | **0** |
| DB writes | **0** (one config read; pool closed before the live call) |
| source opens / search / RPC | **0 / 0 / 0** |

### Interpreting the result

**SUCCESS** establishes: the credential authenticates for count_tokens; the
configured model id is accepted; Anthropic answered through that network
configuration. NOT established: the cause of the earlier acquisition failure,
or that acquisition/generation will succeed.

**FAILURE** prints one closed class: `AUTHENTICATION_FAILED` → credential;
`PERMISSION_DENIED` → access refused; `NOT_FOUND` → configured model id;
`RATE_LIMITED` → usage ceiling; `PROVIDER_SERVER_ERROR` → provider-side;
`NETWORK_NO_RESPONSE` → no provider response observed (no VPN/DNS/geography
inference); `UNCLASSIFIED_PROVIDER_ERROR` → closed unknown. No retry is
prescribed by any of these.

### Boundary, pinned by test

`tests/anthropic-count-tokens-probe.test.ts` — static scan: no
`messages.create`, no research/documentary/on-chain module, no project names,
no DB mutation, production primitives used rather than copied, and no path
that prints the caught exception or the API key.

### Next — the owner's choice

1. **Run the probe** (MantaRay ON). One bounded window; the outcome directly
   informs whether the third acquisition attempt is worth a window and in
   which network configuration.
2. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
