#!/usr/bin/env bash
# Installs Votive for Linux for the current user (no root). Safe to run again.
#   ./linux/install.sh              install and start the tray service
#   ./linux/install.sh --remove     stop it and remove it
# All the work is in Scripts/install-linux.js; this only checks that Node is there.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "Node.js 18 or later is needed. Install it with your package manager, e.g.: sudo apt install nodejs"; exit 1; }
exec node "$ROOT/Scripts/install-linux.js" "$@"
