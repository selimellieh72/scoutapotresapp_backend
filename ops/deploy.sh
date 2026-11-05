#!/usr/bin/env bash
# Install a copy at the root of the dedicated server directory.
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ ${1:-} != --locked ]]; then
  exec flock --nonblock --close "$root/run/deploy.lock" bash "$0" --locked
fi

export PATH="$root/runtime/node/bin:$root/runtime/tools/node_modules/.bin:/usr/bin:/bin"
export XDG_CACHE_HOME="$root/cache"
export XDG_DATA_HOME="$root/runtime"
export XDG_CONFIG_HOME="$root/run/config"
export npm_config_cache="$root/cache/npm"
export npm_config_store_dir="$root/cache/pnpm"
export TMPDIR="$root/run"
export MONGOMS_SYSTEM_BINARY="$root/runtime/mongo/bin/mongod"
export MONGOMS_SYSTEM_BINARY_VERSION_CHECK=false
export GIT_TERMINAL_PROMPT=0

repo=https://github.com/selimellieh72/scoutapotresapp_backend.git
source_repo="$root/source.git"
api_pid_file="$root/run/api.pid"
mongo_pid_file="$root/run/mongo.pid"
ready_url=http://127.0.0.1:3000/ready

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

pid_matches() {
  local pid=$1 executable=$2
  [[ "$pid" =~ ^[1-9][0-9]*$ && /proc/$pid/exe -ef "$executable" ]]
}

start_mongo() {
  local pid
  pid=$(cat "$mongo_pid_file" 2>/dev/null || true)
  if pid_matches "$pid" "$MONGOMS_SYSTEM_BINARY"; then return; fi
  "$MONGOMS_SYSTEM_BINARY" --dbpath "$root/data/mongo" --port 27028 \
    --bind_ip 127.0.0.1 --replSet scout --keyFile "$root/mongo.key" \
    --unixSocketPrefix "$root/run" --logpath "$root/logs/mongo.log" \
    --logappend --pidfilepath "$mongo_pid_file" --fork
}

api_running() {
  local pid
  pid=$(cat "$api_pid_file" 2>/dev/null || true)
  pid_matches "$pid" "$root/runtime/node/bin/node" &&
    [[ $(readlink -f "/proc/$pid/cwd") == "$root/releases/"* ]]
}

start_api() {
  local release=$1
  (
    cd "$release"
    exec nohup node --env-file="$root/.env" dist/server.js
  ) </dev/null >>"$root/logs/api.log" 2>&1 &
  printf '%s\n' "$!" > "$api_pid_file"
}

wait_for_api() {
  local attempt
  for attempt in {1..30}; do
    if ! api_running; then
      # Allow the child to exec Node before checking its identity.
      if (( attempt > 2 )); then return 1; fi
    elif curl -fsS --max-time 2 "$ready_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_api() {
  if ! api_running; then return; fi
  local pid attempt
  pid=$(cat "$api_pid_file")
  kill -TERM "$pid"
  for attempt in {1..12}; do
    if ! api_running; then return; fi
    sleep 1
  done
  log 'API did not stop in time.'
  return 1
}

start_mongo
previous=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -d "$previous" ]] && ! api_running; then
  log "Restarting $(basename "$previous")."
  start_api "$previous"
  wait_for_api
fi

if [[ ! -d "$source_repo" ]]; then git init --bare "$source_repo"; fi
timeout 60 git --git-dir="$source_repo" fetch --quiet --no-tags --depth=1 "$repo" refs/heads/main
revision=$(git --git-dir="$source_repo" rev-parse --verify 'FETCH_HEAD^{commit}')
release="$root/releases/$revision"
if [[ "$release" == "$previous" ]]; then exit 0; fi
if [[ $(cat "$root/run/rejected" 2>/dev/null || true) == "$revision" ]]; then exit 0; fi

if [[ ! -d "$release" ]]; then
  staging=$(mktemp -d "$root/releases/.staging.XXXXXXXX")
  trap 'rm -rf -- "$staging"' EXIT
  git --git-dir="$source_repo" archive "$revision" | tar -xf - -C "$staging"
  log "Building $revision."
  (
    cd "$staging"
    pnpm install --frozen-lockfile
  )
  if ! (cd "$staging" && pnpm check); then
    printf '%s\n' "$revision" > "$root/run/rejected"
    log "Checks failed for $revision."
    exit 1
  fi
  mv -- "$staging" "$release"
  trap - EXIT
fi

if [[ ! -f "$root/run/mongo-initialized" ]]; then
  node --env-file="$root/.env" --env-file="$root/mongo.env" "$release/ops/init-mongo.mjs"
  touch "$root/run/mongo-initialized"
fi

stop_api
start_api "$release"
if ! wait_for_api; then
  log "Readiness failed for $revision."
  stop_api
  if [[ -d "$previous" ]]; then
    start_api "$previous"
    wait_for_api
    log "Restored $(basename "$previous")."
  fi
  printf '%s\n' "$revision" > "$root/run/rejected"
  exit 1
fi

ln -sfn -- "$release" "$root/run/current-next"
mv -Tf -- "$root/run/current-next" "$root/current"
log "Deployed $revision."
