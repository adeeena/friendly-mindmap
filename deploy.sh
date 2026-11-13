#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${HOME:?HOME is not set}/projects/friendly-mindmap"
compose_file="containers/docker-compose.yaml"

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

[[ -d "$app_dir/.git" ]] || fail "Git checkout not found at $app_dir"
[[ -f "$app_dir/containers/.env" ]] || fail "Missing $app_dir/containers/.env"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

cd "$app_dir"

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || fail "expected branch main, found $branch"
[[ -z "$(git status --porcelain)" ]] || fail "working tree must be clean before deployment"

git pull --ff-only origin main
docker compose -f "$compose_file" up -d --build
docker compose -f "$compose_file" ps
