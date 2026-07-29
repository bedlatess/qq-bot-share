#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${PUFF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REMOTE="${PUFF_REMOTE:-origin}"
BRANCH="${PUFF_BRANCH:-main}"
DEPLOY_STATE_FILE="$ROOT_DIR/data/deployed-commit"

cd "$ROOT_DIR"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "[puff-update] tracked files have local changes; update skipped"
  git status --short --untracked-files=no
  exit 2
fi

git fetch --prune "$REMOTE" "$BRANCH"
current_commit="$(git rev-parse HEAD)"
target_commit="$(git rev-parse "$REMOTE/$BRANCH")"
deployed_commit="$(cat "$DEPLOY_STATE_FILE" 2>/dev/null || true)"

if [[ "$current_commit" == "$target_commit" && "$deployed_commit" == "$target_commit" ]]; then
  echo "[puff-update] already current: ${current_commit:0:12}"
  exit 0
fi

if ! git merge-base --is-ancestor "$current_commit" "$target_commit"; then
  echo "[puff-update] remote history is not a fast-forward; update skipped"
  exit 3
fi

container_id="$(docker compose ps -q control 2>/dev/null || true)"
container_state=""
if [[ -n "$container_id" ]]; then
  container_state="$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' "$container_id" 2>/dev/null || true)"
fi
if [[ "$container_state" == "true false" ]]; then
  echo "[puff-update] backing up SQLite"
  docker compose exec -T control node apps/control/dist/tools/backup.js
else
  echo "[puff-update] running container unavailable; online backup skipped"
fi

if [[ "$current_commit" != "$target_commit" ]]; then
  echo "[puff-update] updating ${current_commit:0:12} -> ${target_commit:0:12}"
  git merge --ff-only "$REMOTE/$BRANCH"
else
  echo "[puff-update] source is current; retrying deployment ${target_commit:0:12}"
fi
docker compose up -d --build control

host_port="17866"
if [[ -f .env.production ]]; then
  configured_port="$(sed -n 's/^PORT=\([0-9][0-9]*\).*$/\1/p' .env.production | tail -n 1)"
  [[ -n "$configured_port" ]] && host_port="$configured_port"
fi

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${host_port}/api/health" >/dev/null; then
    mkdir -p "$(dirname "$DEPLOY_STATE_FILE")"
    printf '%s\n' "$target_commit" >"$DEPLOY_STATE_FILE"
    echo "[puff-update] healthy: ${target_commit:0:12}"
    docker compose ps control
    exit 0
  fi
  sleep 3
done

echo "[puff-update] health check failed"
docker compose logs --tail=120 control
exit 4
