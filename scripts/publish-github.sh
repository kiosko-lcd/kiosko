#!/usr/bin/env bash
# Pushes Kiosko and every plugin repo to GitHub.
#
#   scripts/publish-github.sh <owner> [--create]
#
# Without --create the repositories must already exist (empty) on GitHub.
# With --create it makes them with the GitHub CLI (`gh`), public, with the
# description taken from each package.json. Nothing is pushed until you
# answer "y" to the summary.
set -euo pipefail

owner="${1:?usage: scripts/publish-github.sh <owner> [--create]}"
create="${2:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
plugins="$(cd "$root/../kiosko-plugins" 2>/dev/null && pwd || true)"

repos=("$root")
if [[ -n "$plugins" ]]; then
  for d in "$plugins"/kiosko-plugin-*/; do repos+=("${d%/}"); done
fi

echo "Owner: $owner"
for r in "${repos[@]}"; do
  name="$(basename "$r")"
  branch="$(git -C "$r" branch --show-current)"
  echo "  $name  ($(git -C "$r" rev-list --count HEAD) commits on $branch)  →  https://github.com/$owner/$name"
done
read -r -p "Push all of them? [y/N] " ok
[[ "$ok" == "y" ]] || exit 1

for r in "${repos[@]}"; do
  name="$(basename "$r")"
  if [[ "$create" == "--create" ]]; then
    desc="$(node -p "require('$r/package.json').description || ''")"
    gh repo create "$owner/$name" --public --description "$desc" >/dev/null || echo "($name already exists?)"
  fi
  if git -C "$r" remote get-url origin >/dev/null 2>&1; then
    git -C "$r" remote set-url origin "git@github.com:$owner/$name.git"
  else
    git -C "$r" remote add origin "git@github.com:$owner/$name.git"
  fi
  git -C "$r" push -u origin "$(git -C "$r" branch --show-current)"
done
echo "Done. Next: npm publish (see the publishing notes)."
