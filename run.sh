#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

replay_host="${REPLAY_HOST:-localhost}"
replay_port="${REPLAY_PORT:-47831}"

case "${replay_host}" in
  all|ALL|any|ANY) replay_host="0.0.0.0" ;;
esac

echo "DoBackChess is ready at http://localhost:${replay_port}"
echo "Static mode: game import, PGN parsing, and Stockfish run in the browser"
exec python3 -m http.server "${replay_port}" --bind "${replay_host}" --directory static
