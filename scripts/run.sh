#!/usr/bin/env bash
set -e

if ! command -v docker &>/dev/null; then
  echo "  [!!]  Docker not found. Install Docker first: https://docs.docker.com/get-docker/" >&2
  exit 1
fi

echo ""
echo "  whack-a-mole"
echo "  http://localhost"
echo ""
docker compose up --build
