#!/usr/bin/env bash
# Atomic Docker Compose rollout with readiness verification, running-digest check and automatic rollback.
# Usage (bot only):
#   BOT_IMAGE=ghcr.io/hextazdev/tournamenthub-bot:sha-XXXXXXXXXXXX ./deploy/rollout.sh
# Usage (full stack):
#   DEPLOY_PROFILE=full \
#   BOT_IMAGE=ghcr.io/hextazdev/tournamenthub-bot:sha-XXXXXXXXXXXX \
#   WEB_IMAGE=ghcr.io/hextazdev/tournamenthub-web:sha-XXXXXXXXXXXX \
#   ./deploy/rollout.sh
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-tournamenthub-staging}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.production.yml}"
PROFILE="${DEPLOY_PROFILE:-bot}"
BOT_READY_URL="${BOT_READY_URL:-http://127.0.0.1:${BOT_HOST_PORT:-8080}/ready}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:${WEB_HOST_PORT:-3000}/api/health}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-90}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
SKIP_IF_UNCHANGED="${SKIP_IF_UNCHANGED:-0}"

if [[ -z "${BOT_IMAGE:-}" ]]; then
  echo "[ROLLOUT] Error: BOT_IMAGE must be set (e.g. ghcr.io/hextazdev/tournamenthub-bot:sha-...)" >&2
  exit 1
fi
if [[ "$PROFILE" == "full" && -z "${WEB_IMAGE:-}" ]]; then
  echo "[ROLLOUT] Error: WEB_IMAGE must be set when DEPLOY_PROFILE=full" >&2
  exit 1
fi

COMPOSE_ARGS=(-p "$PROJECT" -f "$COMPOSE_FILE")
SERVICES=(bot)
if [[ "$PROFILE" == "full" ]]; then
  COMPOSE_ARGS+=(--profile full)
  SERVICES+=(web)
fi

get_running_image_id() {
  local service="$1"
  local cid
  cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
  fi
}

check_endpoints_ready() {
  curl --silent --show-error --fail --max-time 5 "$BOT_READY_URL" >/dev/null 2>&1 || return 1
  if [[ "$PROFILE" == "full" ]]; then
    curl --silent --show-error --fail --max-time 5 "$WEB_HEALTH_URL" >/dev/null 2>&1 || return 1
  fi
  return 0
}

wait_for_readiness() {
  local elapsed=0
  while (( elapsed < READY_TIMEOUT_SECONDS )); do
    if check_endpoints_ready; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    elapsed=$(( elapsed + POLL_INTERVAL_SECONDS ))
  done
  return 1
}

PREV_BOT_IMAGE_ID="$(get_running_image_id bot)"
PREV_WEB_IMAGE_ID=""
if [[ "$PROFILE" == "full" ]]; then
  PREV_WEB_IMAGE_ID="$(get_running_image_id web)"
fi

echo "[ROLLOUT] Pulling target images for project '$PROJECT' (${SERVICES[*]})..."
docker compose "${COMPOSE_ARGS[@]}" pull "${SERVICES[@]}"

TARGET_BOT_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$BOT_IMAGE")"
TARGET_WEB_IMAGE_ID=""
if [[ "$PROFILE" == "full" ]]; then
  TARGET_WEB_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE")"
fi

if [[ "$SKIP_IF_UNCHANGED" == "1" && -n "$PREV_BOT_IMAGE_ID" && "$PREV_BOT_IMAGE_ID" == "$TARGET_BOT_IMAGE_ID" ]]; then
  if [[ "$PROFILE" != "full" || ( -n "$PREV_WEB_IMAGE_ID" && "$PREV_WEB_IMAGE_ID" == "$TARGET_WEB_IMAGE_ID" ) ]]; then
    if check_endpoints_ready; then
      echo "[ROLLOUT] Running containers already match target digest ($TARGET_BOT_IMAGE_ID) and are healthy; nothing to do."
      exit 0
    fi
  fi
fi

echo "[ROLLOUT] Applying update (target bot digest: $TARGET_BOT_IMAGE_ID)..."
docker compose "${COMPOSE_ARGS[@]}" up -d --no-build "${SERVICES[@]}"

CURRENT_BOT_IMAGE_ID="$(get_running_image_id bot)"
if [[ -n "$TARGET_BOT_IMAGE_ID" && "$CURRENT_BOT_IMAGE_ID" != "$TARGET_BOT_IMAGE_ID" ]]; then
  echo "[ROLLOUT] Error: running bot image ($CURRENT_BOT_IMAGE_ID) does not match target ($TARGET_BOT_IMAGE_ID)" >&2
  ROLLOUT_OK=0
elif wait_for_readiness; then
  ROLLOUT_OK=1
else
  ROLLOUT_OK=0
fi

if [[ "$ROLLOUT_OK" == "1" ]]; then
  echo "[ROLLOUT] Success: services are ready and verified on digest $CURRENT_BOT_IMAGE_ID."
  exit 0
fi

echo "[ROLLOUT] Readiness check failed within ${READY_TIMEOUT_SECONDS}s! Initiating automatic rollback..." >&2
if [[ -n "$PREV_BOT_IMAGE_ID" ]]; then
  export BOT_IMAGE="$PREV_BOT_IMAGE_ID"
  if [[ "$PROFILE" == "full" && -n "$PREV_WEB_IMAGE_ID" ]]; then
    export WEB_IMAGE="$PREV_WEB_IMAGE_ID"
  fi
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-build "${SERVICES[@]}"
  echo "[ROLLOUT] Rolled back to previous image digest ($PREV_BOT_IMAGE_ID)." >&2
else
  echo "[ROLLOUT] No previous running image recorded; stopping failed containers." >&2
  docker compose "${COMPOSE_ARGS[@]}" stop "${SERVICES[@]}" || true
fi
exit 1
