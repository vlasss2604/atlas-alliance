#!/bin/sh
# ATLAS PROOF — run ONE owner command with the hosted environment loaded.
#
# `npm run db:migrate` and the owner CLIs do not read /etc/atlas on their
# own, so they go through this. Run it as the atlas user:
#
#   sudo -u atlas /opt/atlas/app/deploy/wave1/with-env.sh npm run db:migrate
#   sudo -u atlas /opt/atlas/app/deploy/wave1/with-env.sh npm run admin:private-beta -- status
#
# --worker additionally loads the worker-only file, for commands that must
# see the worker's capability declarations (e.g. the renderer probe):
#
#   sudo -u atlas /opt/atlas/app/deploy/wave1/with-env.sh --worker npm run probe:renderer -- <url> <slug>
#
# Override paths with ATLAS_ENV_FILE / ATLAS_WORKER_ENV_FILE / ATLAS_APP_DIR.
# Values are never printed.
set -eu
env_file="${ATLAS_ENV_FILE:-/etc/atlas/atlas.env}"
worker_env_file="${ATLAS_WORKER_ENV_FILE:-/etc/atlas/worker.env}"
app_dir="${ATLAS_APP_DIR:-/opt/atlas/app}"

files="$env_file"
if [ "${1:-}" = "--worker" ]; then
  files="$files $worker_env_file"
  shift
fi
[ "$#" -gt 0 ] || { echo "usage: with-env.sh [--worker] <command> [args...]" >&2; exit 2; }

set -a
for f in $files; do
  [ -r "$f" ] || { echo "[with-env] cannot read $f" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$f"
done
set +a
cd "$app_dir"
exec "$@"
