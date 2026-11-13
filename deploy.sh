#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${HOME:?HOME is not set}/projects/friendly-mindmap"
compose_file="containers/docker-compose.yaml"
repo_url="https://github.com/adeeena/friendly-mindmap.git"

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

if [[ ! -d "$app_dir/.git" ]]; then
  if [[ -d "$app_dir" && -n "$(ls -A "$app_dir")" ]]; then
    fail "$app_dir exists and is not an empty Git checkout"
  fi
  mkdir -p "$(dirname "$app_dir")"
  git clone --branch main --single-branch "$repo_url" "$app_dir"
fi

if [[ ! -f "$app_dir/containers/.env" ]]; then
  cp "$app_dir/containers/.env.example" "$app_dir/containers/.env"
  fail "created $app_dir/containers/.env; set production secrets and HTTPS settings, then rerun"
fi

cd "$app_dir"

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || fail "expected branch main, found $branch"
[[ -z "$(git status --porcelain)" ]] || fail "working tree must be clean before deployment"

git pull --ff-only origin main
docker compose -f "$compose_file" up -d --build
docker compose -f "$compose_file" ps
