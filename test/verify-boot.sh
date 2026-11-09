#!/usr/bin/env bash
# verify-boot.sh — boot an ISOLATED DSH instance on a fresh port with the
# dsh-browser-host plugin mounted, for verification/testing.
#
# RULE: never touch the 3080 production instance. Every verification uses a
# brand-new port and its own DSH_HOME (test/env/home-<port>), so the running
# harness's profiles, sessions and settings are untouched.
#
# Usage:
#   ./test/verify-boot.sh [port]         # boot on the given port (default 4101)
#   ./test/verify-boot.sh [port] stop    # stop the instance on that port
#
# The instance's token is written to test/env/browser-client-token-<port> and
# its log to test/env/boot-<port>.log. Tests should point TOKEN_FILE at the
# per-port token and DSH_BASE at http://127.0.0.1:<port>.
#
# Requirements: the DSH CLI is resolved from $DSH_BIN or PATH (`dsh`).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$ROOT/test/env"
PORT="${1:-4101}"
ACTION="${2:-boot}"
PROFILE="verify-$PORT"
DSH_HOME_DIR="$ENV_DIR/home-$PORT"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"

if [ -z "$DSH_BIN" ]; then
  echo "✗ cannot find the dsh CLI; set DSH_BIN=/path/to/dsh" >&2
  exit 1
fi

case "$ACTION" in
  stop)
    if [ -f "$ENV_DIR/dsh-$PORT.pid" ]; then
      kill "$(cat "$ENV_DIR/dsh-$PORT.pid")" 2>/dev/null || true
      rm -f "$ENV_DIR/dsh-$PORT.pid"
      echo "stopped instance on :$PORT"
    else
      echo "no instance on :$PORT"
    fi
    exit 0
    ;;
esac

mkdir -p "$ENV_DIR" "$DSH_HOME_DIR"

# Per-port overlay: mount the plugin, persist token to a per-port file.
cat > "$ENV_DIR/overlay-$PORT.yml" <<EOF
- insert:
    - id: dsh-browser-host
      name: '$ROOT/lib/index.js'
      config:
        extPrefix: /ext-api
        extEventsPath: /ext-events.mux
        persistToken: true
        tokenFile: $ENV_DIR/browser-client-token-$PORT
        toolTimeoutMs: 60000
EOF

echo "booting isolated DSH on :$PORT (plugin: $ROOT/lib/index.js)…"
(
  cd "$ENV_DIR"
  DSH_HOME="$DSH_HOME_DIR" nohup node "$DSH_BIN" \
    --profile "$PROFILE" --from-default-profile web \
    --patch "$ENV_DIR/overlay-$PORT.yml" --port "$PORT" --no-open \
    > "$ENV_DIR/boot-$PORT.log" 2>&1 &
  echo $! > "$ENV_DIR/dsh-$PORT.pid"
)

# Wait for the plugin to report readiness.
for i in $(seq 1 40); do
  if grep -q "dsh web:" "$ENV_DIR/boot-$PORT.log" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "=== boot-$PORT.log ==="
grep -E "extension token|registered tool|workflow store|dsh web|Error|error" "$ENV_DIR/boot-$PORT.log" | head -20 || true

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ instance ready on http://127.0.0.1:$PORT"
  echo "  token: $ENV_DIR/browser-client-token-$PORT"
else
  echo "✗ instance failed to boot on :$PORT — see $ENV_DIR/boot-$PORT.log"
  exit 1
fi
