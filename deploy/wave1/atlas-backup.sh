#!/bin/sh
# ATLAS PROOF — Wave 1 nightly Postgres backup (run by atlas-backup.timer as
# the postgres OS user, peer auth, no password anywhere).
#
# Writes a pg_dump custom-format archive, checks it is a readable archive,
# records its sha256, keeps ATLAS_BACKUP_KEEP_DAYS days locally and, if
# ATLAS_BACKUP_RCLONE_REMOTE names an rclone remote (e.g. "atlasbackup:atlas"),
# copies it off the server.
set -eu
umask 077

db="${ATLAS_DB_NAME:-atlas_beta}"
dir="${ATLAS_BACKUP_DIR:-/var/backups/atlas}"
keep_days="${ATLAS_BACKUP_KEEP_DAYS:-14}"
remote="${ATLAS_BACKUP_RCLONE_REMOTE:-}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/$db-$stamp.dump"

pg_dump --format=custom --file="$out.partial" "$db"
pg_restore --list "$out.partial" > /dev/null
mv "$out.partial" "$out"
(cd "$dir" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")

find "$dir" -maxdepth 1 -name "$db-*.dump*" -mtime +"$keep_days" -delete

if [ -n "$remote" ]; then
  rclone copy "$out" "$remote"
  rclone copy "$out.sha256" "$remote"
fi
echo "[atlas-backup] wrote $(basename "$out")${remote:+ and copied off-server}"
