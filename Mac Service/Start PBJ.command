#!/bin/zsh
set -eu
SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h}
NODE_BIN=${PBJ_NODE:-$(command -v node || true)}
if [[ -z "$NODE_BIN" ]]; then
  echo 'Node.js 24 or newer is required. Install Node or set PBJ_NODE to its executable path.'
  exit 1
fi
cd "$PROJECT_ROOT/server"
echo 'PB&J Mac AI Service — leave this window open. Use Stop PBJ to stop safely.'
exec /usr/bin/caffeinate -i "$NODE_BIN" "$PROJECT_ROOT/server/scripts/personal-service-runner.ts" "$PROJECT_ROOT/server/data/personal-service/config.json"
