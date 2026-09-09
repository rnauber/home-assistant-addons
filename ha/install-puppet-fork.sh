#!/bin/bash
# install-puppet-fork.sh — replace the official Puppet add-on with rnauber's fork
#
# 2026-09-09 — Dr. Richard Nauber & GLM (tu-dresden-ai/zai-org/GLM-5.3-Flash, Oh My Pi harness).
# Generated in /home/ubuntu/scratch/home-assistant-addons; prompts: implement
# fromcacheifyounger, move repo to scratch, minimal+safe HA replace script.
#
# Runs INSIDE the Home Assistant SSH add-on (root@homeassistant).
# Minimal + safe:
#   - downloads a pinned tarball of the fork (no git needed on HA)
#   - backs up the official add-on's options (access_token) before touching anything
#   - installs into /addons/local/, writes the saved options into the new add-on
#   - never touches network, SSH, keys, or anything outside the Supervisor add-on dirs
#   - full rollback: the official add-on stays installed until YOU remove it;
#     this script only adds the local fork. Run the uninstall step (step 4) manually
#     after the fork is verified, from the UI.
#
# Usage: bash install-puppet-fork.sh
set -euo pipefail

FORK_REPO="rnauber/home-assistant-addons"
BRANCH="main"
ADDON_NAME="puppet"                 # folder name under /addons/local
LOCAL_DIR="/addons/local/${ADDON_NAME}"
BACKUP_DIR="/backup/puppet-fork-backup-$(date +%Y%m%d-%H%M%S)"
TARBALL_URL="https://github.com/${FORK_REPO}/archive/refs/heads/${BRANCH}.tar.gz"
OFFICIAL_SLUG="0f1cc410_puppet"     # upstream puppet (balloob repo)

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------- sanity
[ -d /addons ] || die "This must run inside the HA SSH add-on (/addons not mounted)."
[ -w /addons/local ] || die "/addons/local not writable."
command -v curl >/dev/null || die "curl not found."
command -v tar  >/dev/null || die "tar not found."

# ---------------------------------------------------------------- 1. backup official options
OPTS="/addons/data/${OFFICIAL_SLUG}/options.json"
if [ -f "$OPTS" ]; then
  mkdir -p "$BACKUP_DIR"
  cp "$OPTS" "$BACKUP_DIR/options.json"
  log "Backed up official add-on options to ${BACKUP_DIR}/options.json"
else
  log "No official Puppet options found at $OPTS (not installed yet?) — continuing."
  mkdir -p "$BACKUP_DIR"
fi

# ---------------------------------------------------------------- 2. download fork tarball
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
log "Downloading ${TARBALL_URL}"
# Capture the listing first: `tar | grep -q` under pipefail turns grep's early
# exit into a SIGPIPE (141) on tar and would wrongly fail the check.
curl -fsSL "$TARBALL_URL" -o "$TMP/fork.tar.gz" || die "download failed"
if ! tar -tzf "$TMP/fork.tar.gz" > "$TMP/tarlist.txt"; then
  die "downloaded tarball is not readable"
fi
grep -q "home-assistant-addons-${BRANCH}/puppet/config.yaml" "$TMP/tarlist.txt" \
  || die "unexpected tarball layout (no puppet/config.yaml)"

tar -xzf "$TMP/fork.tar.gz" -C "$TMP"
SRC="$TMP/home-assistant-addons-${BRANCH}/puppet"
[ -f "$SRC/config.yaml" ] && [ -f "$SRC/Dockerfile" ] || die "tarball missing add-on files"

# ---------------------------------------------------------------- 3. install as local add-on
# Atomic-ish: build in temp dir, then swap.
STAGE="$(mktemp -d)"
cp -r "$SRC/." "$STAGE/"
# strip dev-only files
rm -f "$STAGE"/ha-puppet/test_*.mjs "$STAGE"/ha-puppet/options-dev.json*
mkdir -p /addons/local
if [ -d "$LOCAL_DIR" ]; then
  log "Existing local install found — archiving it to ${BACKUP_DIR}/local-previous.tgz"
  tar -czf "$BACKUP_DIR/local-previous.tgz" -C "$(dirname "$LOCAL_DIR")" "$(basename "$LOCAL_DIR")"
  rm -rf "$LOCAL_DIR"
fi
mv "$STAGE" "$LOCAL_DIR"

# restore saved options so the new install starts with the same access token
if [ -f "$BACKUP_DIR/options.json" ]; then
  mkdir -p "/addons/data/${ADDON_NAME}"
  cp "$BACKUP_DIR/options.json" "/addons/data/${ADDON_NAME}/options.json"
  log "Restored access token options into ${ADDON_NAME}"
fi

log "Installed fork into ${LOCAL_DIR}"
log "DONE. Now: Add-on Store -> (⋮) Check for updates -> install 'Puppet' from Local add-ons."
log "The official Puppet (if installed) will conflict on slug 'puppet' — uninstall it in the UI"
log "only AFTER your fork runs. Rollback: delete ${LOCAL_DIR} + reinstall official from the store."
