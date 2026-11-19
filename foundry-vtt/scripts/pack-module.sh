#!/usr/bin/env bash
# Zips the Foundry module for installing: module.json at the root of the archive.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/stream-deck-bridge.zip
(cd module && zip -qr ../dist/stream-deck-bridge.zip module.json LICENSE README.md lang scripts)
echo "dist/stream-deck-bridge.zip"
