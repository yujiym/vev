#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exercises M0's exit condition (docs/spec.md §18): `pnpm live` —
# the built SPA served by the local Worker on one origin — actually serves
# both the app and the API. CI never did this (I1 in the M0 whole-branch
# review); this script is the thing CI runs, and the thing you can run
# yourself: `bash scripts/smoke-live.sh`.
#
# It runs `pnpm live` itself rather than reimplementing its steps (build,
# migrate, `cf dev`), so a regression in that script fails this check
# too instead of only being caught by a script that quietly duplicates it.
set -euo pipefail
set -m # `pnpm live` gets its own process group, so the EXIT trap can kill
       # the whole cf/Vite/workerd tree it spawns, not just the immediate
       # `pnpm` process (portable: works without setsid on Linux and macOS).

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

log_file="$(mktemp)"
origin="http://127.0.0.1:8787"

pnpm live >"$log_file" 2>&1 &
live_pid=$!

cleanup() {
  kill -- "-${live_pid}" 2>/dev/null || true
  wait "$live_pid" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  echo "--- pnpm live output ---" >&2
  cat "$log_file" >&2
  exit 1
}

# Wait for the Worker to answer, rather than a fixed sleep: cold-start time
# (workerd startup, D1 migration) varies with the machine and the runner.
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$live_pid" 2>/dev/null; then
    fail "pnpm live exited before it became ready"
  fi
  if curl -sf -o /dev/null "$origin/api/health"; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "pnpm live did not answer http://127.0.0.1:8787/api/health within 60s"

echo "== /api/health =="
health="$(curl -sf "$origin/api/health")"
echo "$health"
echo "$health" | grep -q '"ok":true' || fail '/api/health did not report ok:true'
for field in '"commit"' '"mode"' '"settingsRows"'; do
  echo "$health" | grep -q "$field" || fail "/api/health response is missing $field"
done

echo "== unmatched deep path falls through to the SPA =="
deep_body="$(curl -sf "$origin/studio/some/unmatched/deep/path")"
build_index="$root_dir/apps/web/build/index.html"
[ -f "$build_index" ] || fail "apps/web/build/index.html is missing after \`pnpm live\` built it"
if [ "$deep_body" != "$(cat "$build_index")" ]; then
  fail "an unmatched deep path did not return the built SPA's index.html"
fi
echo "matches apps/web/build/index.html"

echo "== an unmatched /api/* path still 404s (not swallowed by the SPA fallback) =="
api_404_code="$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/this-route-does-not-exist")"
[ "$api_404_code" = "404" ] || fail "expected 404 for an unmatched /api/* path, got $api_404_code"
echo "404 as expected"

echo "SMOKE OK: pnpm live serves the API and the SPA on one origin"
