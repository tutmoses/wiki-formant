#!/bin/sh
# Fails when src/ at HEAD differs from what npm already serves under the same
# version — a change that ships nowhere. Run by CI on every push and by the
# pre-push hook, so the push is refused here before CI can fail on it.
#
# The comparison is against the commit npm's current version was BUILT from
# (its gitHead), not against the push's base. Versions are often published from
# a laptop before the commit is pushed; diffing the push range then flagged
# 0.26.1 and 0.27.0 as unshipped when npm held exactly that src.
set -eu

NAME="$(jq -r .name package.json)"
LOCAL="$(jq -r .version package.json)"
PUBLISHED="$(npm view "$NAME" version 2>/dev/null || echo none)"

if [ "$LOCAL" != "$PUBLISHED" ]; then
  echo "$LOCAL is not on npm yet (npm has $PUBLISHED) — it ships on publish."
  exit 0
fi

SHIPPED="$(npm view "$NAME@$LOCAL" gitHead 2>/dev/null || true)"
if [ -z "$SHIPPED" ] || ! git cat-file -e "$SHIPPED^{commit}" 2>/dev/null; then
  echo "npm records no reachable commit for $LOCAL — cannot compare, skipping."
  exit 0
fi

if ! git diff --quiet "$SHIPPED" HEAD -- src; then
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::error::' >&2
  echo "src/ changed since $LOCAL was published from $(git rev-parse --short "$SHIPPED"), and package.json still says $LOCAL. Bump the version (npm version patch|minor) before pushing, or these changes ship nowhere." >&2
  git diff --stat "$SHIPPED" HEAD -- src >&2
  exit 1
fi

echo "src/ matches $LOCAL on npm."
