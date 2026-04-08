#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h}
PORT=${CLAUDE_PROXY_PORT:-8787}
MODEL=""
BASE_URL=""
API_KEY=${CLAUDE_PROXY_BEARER_TOKEN:-${ANTHROPIC_API_KEY:-}}
RUNTIME_DIR="$PROJECT_ROOT/.claude-proxy"
PID_FILE=""
LOG_FILE=""

usage() {
  cat <<'EOF'
Usage:
  pnpm proxy:claude:setup -- --model <target-model> --base-url <gateway-base-url> [--port <port>] [--api-key <token>]

Example:
  pnpm proxy:claude:setup -- \
    --model ep-5wie4c-1770729260902533469 \
    --base-url https://wanqing-api.corp.kuaishou.com/api/gateway/v1
EOF
}

while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--" ]]; then
    shift
    continue
  fi
  case "$1" in
    --model)
      MODEL=${2:-}
      shift 2
      ;;
    --base-url)
      BASE_URL=${2:-}
      shift 2
      ;;
    --port)
      PORT=${2:-}
      shift 2
      ;;
    --api-key)
      API_KEY=${2:-}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MODEL" || -z "$BASE_URL" ]]; then
  usage >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR"
PID_FILE="$RUNTIME_DIR/proxy-${PORT}.pid"
LOG_FILE="$RUNTIME_DIR/proxy-${PORT}.log"

old_pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$old_pids" ]]; then
  echo "$old_pids" | xargs kill -9
fi

cmd=(pnpm proxy:claude)

echo "Starting Claude proxy on port $PORT..."
(
  cd "$PROJECT_ROOT"
  CLAUDE_PROXY_PORT="$PORT" \
  CLAUDE_PROXY_TARGET_MODEL="$MODEL" \
  CLAUDE_PROXY_TARGET_BASE_URL="$BASE_URL" \
  CLAUDE_PROXY_BEARER_TOKEN="$API_KEY" \
  nohup "${cmd[@]}" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
)

health_url="http://127.0.0.1:${PORT}/health"
for _ in {1..30}; do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "$health_url" >/dev/null 2>&1; then
  echo "Claude proxy failed to start. Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

health_json=$(curl -fsS "$health_url")

echo
printf '%s\n' "Claude proxy is ready."
printf '%s\n' "Health: $health_json"
printf '%s\n' "PID file: $PID_FILE"
printf '%s\n' "Log file: $LOG_FILE"
echo
printf '%s\n' "Use Claude Code in another terminal:" 
printf '%s\n' "unset ANTHROPIC_AUTH_TOKEN"
printf '%s\n' "export ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}/v1"
if [[ -n "$API_KEY" ]]; then
  printf '%s\n' "export ANTHROPIC_API_KEY=$API_KEY"
else
  printf '%s\n' 'export ANTHROPIC_API_KEY=<your_api_key>'
fi
printf '%s\n' 'claude --model "claude-opus-4-6"'
