#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exercises M0's exit condition (docs/spec.md §18): `pnpm live` —
# the built app served by the local Worker on one origin — actually serves
# both the pages and the API. CI never did this (I1 in the M0 whole-branch
# review); this script is the thing CI runs, and the thing you can run
# yourself: `bash scripts/smoke-live.sh`.
#
# It runs `pnpm live` itself rather than reimplementing its steps (build,
# migrate, `vp preview`), so a regression in that script fails this check
# too instead of only being caught by a script that quietly duplicates it.
set -euo pipefail
set -m # `pnpm live` gets its own process group, so the EXIT trap can kill
       # the whole Void/Vite/workerd tree it spawns, not just the immediate
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

echo "== a page path serves the app shell, with its own component =="
studio_body="$(curl -sf "$origin/studio")"
echo "$studio_body" | grep -q '"component":"studio"' || fail "/studio did not carry the studio page's shell"
echo "$studio_body" | grep -q 'data-void-ssr="false"' || fail "/studio was not a client-mounted shell"

echo "== an unmatched deep path still reaches the app =="
deep_body="$(curl -sf "$origin/studio/some/unmatched/deep/path")" || fail "an unmatched deep path did not answer 200"
echo "$deep_body" | grep -q '"component":"\[...path\]"' || fail "an unmatched deep path did not reach the app's catch-all page"
client_script="$(echo "$deep_body" | grep -o 'src="/assets/pages-client-[^"]*\.js"' | head -n 1 | sed 's/^src="//; s/"$//')"
[ -n "$client_script" ] || fail "the app shell does not reference its client script"
curl -sf -o /dev/null "$origin$client_script" || fail "the client script $client_script the shell references does not load"
echo "shell loads $client_script"

echo "== a missing file is a 404, not the app shell =="
file_404_code="$(curl -s -o /dev/null -w '%{http_code}' "$origin/assets/this-file-does-not-exist.js")"
[ "$file_404_code" = "404" ] || fail "expected 404 for a missing asset, got $file_404_code"
echo "404 as expected"

echo "== an unmatched /api/* path still 404s (not swallowed by the app's catch-all) =="
api_404_code="$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/this-route-does-not-exist")"
[ "$api_404_code" = "404" ] || fail "expected 404 for an unmatched /api/* path, got $api_404_code"
echo "404 as expected"

echo "== the source offer names the commit /api/health reports (§14.1) =="
commit="$(echo "$health" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
echo "$studio_body" | grep -q "\"commit\":\"$commit\"" || fail "the page's shared data does not carry commit $commit"
echo "$studio_body" | grep -q '"sourceUrl":"https://' || fail "the page's shared data carries no source URL"
echo "commit $commit"

echo "SMOKE OK: pnpm live serves the API and the app on one origin"
