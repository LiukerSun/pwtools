#!/bin/sh
set -eu
umask 077
cd /opt/pwtools
backup_root=/opt/pwtools/backups
mkdir -p "$backup_root"
chmod 700 "$backup_root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$backup_root/pwtools-$stamp.dump.tmp"
final="$backup_root/pwtools-$stamp.dump"
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
docker compose --env-file /opt/pwtools/.env -f deploy/compose.production.yaml exec -T postgres \
    pg_dump -U pwtools -d pwtools --format=custom --no-owner --no-acl > "$temporary"
test -s "$temporary"
mv -- "$temporary" "$final"
sha256sum "$final" > "$final.sha256"
# Limit retention cleanup to regular files created by this script in this fixed directory.
find "$backup_root" -maxdepth 1 -type f \( -name 'pwtools-????????T??????Z.dump' -o -name 'pwtools-????????T??????Z.dump.sha256' \) -mtime +13 -delete
printf 'Database backup complete: %s\n' "$stamp"
