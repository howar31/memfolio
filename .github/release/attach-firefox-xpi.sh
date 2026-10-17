#!/usr/bin/env bash
# Attaches the Mozilla-signed Firefox file of version $1 to the GitHub release
# v$1 once addons.mozilla.org lists that version as public. $2 is how many
# minutes to keep checking (0 checks once). Exits 2 when the version is still
# not public at the end.
set -euo pipefail

V="$1"
WAIT_MIN="${2:-0}"
TAG="v$V"
NAME="memfolio-firefox-$V.xpi"

if gh release view "$TAG" --json assets --jq '.assets[].name' | grep -x "$NAME" >/dev/null; then
  echo "$NAME is already attached to $TAG"
  exit 0
fi

deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
while :; do
  URL="$(curl -sS -f "https://addons.mozilla.org/api/v5/addons/addon/memfolio/" 2>/dev/null | V="$V" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const v = JSON.parse(s).current_version;
      if (v && v.version === process.env.V && v.file && v.file.status === "public") console.log(v.file.url);
    });' || true)"
  [ -n "$URL" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "$V is not public on addons.mozilla.org yet"
    exit 2
  fi
  sleep 120
done

dir="$(mktemp -d)"
curl -sS -f -L -o "$dir/$NAME" "$URL"
test "$(unzip -p "$dir/$NAME" manifest.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')" = "$V"
unzip -l "$dir/$NAME" | grep 'META-INF/cose.sig' >/dev/null
gh release upload "$TAG" "$dir/$NAME"
echo "attached $NAME to $TAG"
