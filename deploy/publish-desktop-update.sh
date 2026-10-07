#!/bin/sh
set -eu
umask 077
# Run from an owned /opt/pwtools/updates/staging-<UUID> directory after uploading
# latest.json, its versioned installer, this script and (on first use) the vhost.
stage=$(pwd -P)
case "$stage" in /opt/pwtools/updates/staging-*) ;; *) echo 'Unexpected staging directory' >&2; exit 1;; esac
stage_id=${stage##*/staging-}
case "$stage_id" in *[!a-f0-9]*|'') echo 'Invalid staging identifier' >&2; exit 1;; esac
[ "${#stage_id}" -eq 32 ] || exit 1
target=/opt/1panel/www/sites/pwtools.liukersun.com/updates/windows-x64
mode=${1:-publish}
[ "$mode" = publish ] || [ "$mode" = configure ] || exit 1
channel=${2:-stable}
case "$channel" in stable) ;; beta) target="$target/beta" ;; *) echo 'Invalid update channel' >&2; exit 1;; esac
# Serialize validation and publication so concurrent releases cannot overwrite
# an immutable version or move the latest manifest backwards.
exec 9>/opt/pwtools/updates/publish.lock
flock -x 9

python3 - "$stage" "$target" "$channel" <<'PY'
import hashlib, json, os, pathlib, re, sys
stage, target = map(pathlib.Path, sys.argv[1:3])
channel = sys.argv[3]
source = stage / 'latest.json'
if source.stat().st_size > 32768:
    raise SystemExit('Manifest is too large')
release = json.loads(source.read_text(encoding='utf-8'))
if release.get('channel', 'stable') != channel:
    raise SystemExit('Manifest channel does not match publication target')
version = release.get('version', '')
if not re.fullmatch(r'(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})', version) or any(int(x) > 65535 for x in version.split('.')):
    raise SystemExit('Invalid stable version')
if release.get('schema_version') != 1 or release.get('platform') != 'windows-x64':
    raise SystemExit('Invalid update schema')
if not isinstance(release.get('notes'), str) or len(release['notes'].encode()) > 6000:
    raise SystemExit('Invalid release notes')
if not isinstance(release.get('published_at'), str) or len(release['published_at']) > 40:
    raise SystemExit('Invalid release date')
name = f'PWTools-Setup-{version}.exe'
installer = stage / name
if installer.is_symlink() or not installer.is_file():
    raise SystemExit('Installer missing')
data = installer.read_bytes()
if not 2 <= len(data) <= 256 * 1024 * 1024 or data[:2] != b'MZ' or release.get('size') != len(data) or release.get('sha256') != hashlib.sha256(data).hexdigest():
    raise SystemExit('Installer integrity check failed')
target.mkdir(parents=True, exist_ok=True)
if any(path.is_symlink() for path in [target, *target.parents]):
    raise SystemExit('Unexpected update directory link')
target.parent.chmod(0o755)
target.chmod(0o755)
latest = target / 'latest.json'
if latest.exists():
    previous = json.loads(latest.read_text(encoding='utf-8'))
    if tuple(map(int, version.split('.'))) < tuple(map(int, previous['version'].split('.'))):
        raise SystemExit('Refusing to publish an older version')
destination = target / name
if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() != release['sha256']:
    raise SystemExit('This version already exists with different bytes; increase the version')
if not destination.exists():
    temporary = target / (name + '.upload-' + stage.name)
    with temporary.open('xb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    temporary.chmod(0o644)
    os.replace(temporary, destination)
# The manifest is replaced only after the immutable binary is complete.
temporary = target / ('latest.json.upload-' + stage.name)
with temporary.open('x', encoding='utf-8') as file:
    json.dump(release, file, ensure_ascii=False, indent=2)
    file.write('\n')
    file.flush()
    os.fsync(file.fileno())
temporary.chmod(0o644)
os.replace(temporary, latest)
print(f'Published {version}: {len(data)} bytes, SHA-256 {release["sha256"]}')
PY

if [ "$mode" = configure ]; then
    vhost=/opt/1panel/www/conf.d/pwtools.liukersun.com.conf
    backup=/opt/pwtools/updates/pwtools.nginx.conf.before-$stage_id
    [ -f "$stage/pwtools.nginx.conf" ] && [ -f "$vhost" ] || exit 1
    openresty=$(docker ps --filter label=com.docker.compose.service=openresty --format '{{.Names}}')
    [ -n "$openresty" ] && [ "$(printf '%s\n' "$openresty" | wc -l)" -eq 1 ] || { echo 'Cannot identify Openresty' >&2; exit 1; }
    cp -p "$vhost" "$backup"
    chmod 600 "$backup"
    cp "$stage/pwtools.nginx.conf" "$vhost"
    if docker exec "$openresty" nginx -t; then
        if ! docker exec "$openresty" nginx -s reload; then
            cp -p "$backup" "$vhost"
            docker exec "$openresty" nginx -t && docker exec "$openresty" nginx -s reload
            exit 1
        fi
        cp "$stage/pwtools.nginx.conf" /opt/pwtools/deploy/pwtools.nginx.conf
    else
        cp -p "$backup" "$vhost"
        exit 1
    fi
fi
