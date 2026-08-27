# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The MECHANISM_SPEC re-extraction is **prepared and gated, not run**. MantaRay is
up, so both `pump.fun` and `api.anthropic.com` resolve into `198.18.0.0/15` and
the fetch and the model call would both be SSRF-blocked. No semantic conclusion
can be drawn about whether the current pipeline files the statement correctly.

Details and the full pre-flight in `PUMP_CASE.md`, "The supported re-extraction
path, prepared and gated offline".

### Ready to run, in a tunnel-off window

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://pump.fun/pump-token \
  --component=MECHANISM_SPEC \
  --step=3 \
  --actor=owner \
  --project=pump_fun
```

Footprint: at most two source opens against `pump.fun` (static fetch, plus one
isolated render if that gate opens) and **one** Anthropic call. No search query
is issued and no query model is called.

Every other gate was verified offline and passes — `internal_alpha_enabled`, the
API key, the live allowlist, the extractor model, an active topic, and the scope
gate at CONFIRMED / OFFICIAL_DOCS.

### After it runs

Verify from persisted data only: source class, officiality, component,
relationship/directness, exact fragment, documentary provenance, and whether S5
now reconciles MECHANISM_SPEC differently. Do not re-run DESTINATION to improve
it, and do not edit the old rows.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF to accommodate the tunnel.
- This task does not touch the actor → acquisition bridge.
