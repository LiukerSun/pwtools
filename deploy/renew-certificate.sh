#!/bin/sh
set -eu
# Certbot may renew other sites on this shared host; handle only this lineage.
if [ "${RENEWED_LINEAGE:-}" != /etc/letsencrypt/live/pwtools.liukersun.com ]; then
    exit 0
fi
install -m 644 "$RENEWED_LINEAGE/fullchain.pem" /opt/1panel/www/sites/pwtools.liukersun.com/ssl/fullchain.pem
install -m 600 "$RENEWED_LINEAGE/privkey.pem" /opt/1panel/www/sites/pwtools.liukersun.com/ssl/privkey.pem
set -- $(docker ps -q --filter label=com.docker.compose.project=openresty --filter label=com.docker.compose.service=openresty)
if [ "$#" -ne 1 ]; then
    echo 'Expected exactly one running Openresty service; certificate reload stopped.' >&2
    exit 1
fi
docker exec "$1" openresty -t
docker exec "$1" openresty -s reload
