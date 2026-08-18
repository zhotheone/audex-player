#!/usr/bin/env bash
set -euo pipefail

# scripts/build-win.sh: Builds the Windows version in the Windows folder via powershell.exe

WIN_DIR="${WIN_DIR:-/mnt/d/1.Projects/audex-player}"
WSL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Generating build info from git..."
node "$WSL_DIR/scripts/build-info.js"

mkdir -p "$WIN_DIR"
echo "==> Syncing files to $WIN_DIR..."
rsync -rt --delete \
  --no-perms --no-owner --no-group \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'release' \
  --exclude 'yt-dlp-bundle' \
  --exclude 'docs' \
  --exclude 'tests' \
  --exclude '.github' \
  --exclude '.githooks' \
  "$WSL_DIR/" "$WIN_DIR/"

WIN_PATH=$(wslpath -w "$WIN_DIR" 2>/dev/null || echo "$WIN_DIR")

echo "==> Building Windows version in $WIN_PATH..."
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
  Set-Location '$WIN_PATH'
  if (-not (Test-Path 'node_modules')) {
    Write-Host '==> Installing Windows dependencies...'
    npm install
  }
  npm run build
" </dev/null
echo "==> Build complete! Output in: $WIN_PATH\release"
