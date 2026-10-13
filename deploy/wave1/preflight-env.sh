#!/bin/sh
# ATLAS PROOF — Wave 1 environment preflight.
#
# Runs as ExecStartPre of atlas-web / atlas-worker and refuses to start a
# process whose environment is wrong. Prints variable NAMES only, never a
# value. Exit 0 = start, non-zero = systemd does not start the service.
#
#   preflight-env.sh web
#   preflight-env.sh worker
set -u

role="${1:-}"
case "$role" in
  web | worker) ;;
  *) echo "usage: preflight-env.sh web|worker" >&2; exit 2 ;;
esac

fail=0
say() { echo "[atlas-preflight:$role] $*" >&2; }
value() { printenv "$1" 2>/dev/null || true; }

# Development-only switches and every proxy variable. A proxy on the worker
# would reroute pinned, SSRF-validated fetches; on the web it would route
# the Interpreter through a local workaround that production does not need.
for name in AUTH_DEV_BYPASS ATLAS_DEV_PROVIDER_PROXY \
            HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy \
            NODE_USE_ENV_PROXY; do
  if [ -n "$(value "$name")" ]; then say "FORBIDDEN variable is set: $name"; fail=1; fi
done

if [ "$(value NODE_ENV)" != "production" ]; then say "NODE_ENV must be production"; fail=1; fi

required="DATABASE_URL ANTHROPIC_API_KEY"
if [ "$role" = web ]; then
  required="$required BOT_TOKEN CSRF_SECRET ALLOWED_ORIGINS"
else
  required="$required BRAVE_SEARCH_API_KEY SOLANA_MAINNET_RPC_URL ETHEREUM_MAINNET_RPC_URL PLAYWRIGHT_BROWSERS_PATH"
fi
for name in $required; do
  if [ -z "$(value "$name")" ]; then say "required variable missing: $name"; fail=1; fi
done

if [ "$role" = web ]; then
  # The session cookie is Secure; SameSite=None — an http origin can never work.
  old_ifs=$IFS; IFS=,
  for origin in $(value ALLOWED_ORIGINS); do
    case "$origin" in
      https://*) ;;
      *) say "ALLOWED_ORIGINS entry is not https"; fail=1 ;;
    esac
  done
  IFS=$old_ifs
else
  [ "$(value ATLAS_WORKER_CAPABILITIES)" = "SEARCH_EXTRACT,FETCH" ] || { say "ATLAS_WORKER_CAPABILITIES must be SEARCH_EXTRACT,FETCH"; fail=1; }
  [ "$(value ONCHAIN_RESEARCH_ENABLED)" = "1" ] || { say "ONCHAIN_RESEARCH_ENABLED must be 1"; fail=1; }
  [ "$(value RENDERED_DOCS_ENABLED)" = "1" ] || { say "RENDERED_DOCS_ENABLED must be 1"; fail=1; }
fi

if [ "$fail" -eq 0 ]; then say "ok"; fi
exit "$fail"
