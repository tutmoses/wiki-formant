# CLAUDE.md — wiki-formant

## Git: main only

Never create, check out or push a branch, and never use a worktree. Commit straight to `main`, in local and cloud sessions alike, and push only when asked: pushes are batched, because each one to an app repo is a Vercel build (root `CLAUDE.md`). A cloud session pushes `main` when its work is done, since its commits exist nowhere else. A cloud session that starts on a `claude/<slug>` branch switches to `main` before committing; if pushing `main` is refused, it stops and says so instead of pushing the branch. Reading or merging a branch that already exists is fine. Open a PR only when asked.

Restated in every repo because a cloud session clones this repo alone and never sees `~/Desktop/GitHub/CLAUDE.md`.

## Versions

A commit that changes `src/` bumps `package.json` in the same commit. `scripts/unshipped.sh` refuses a push whose `src/` differs from what npm serves under the current version; it runs as the pre-push hook (`npm install` wires `.githooks`) and again in CI. It compares against the commit npm's version was built from, so publishing locally before pushing is fine. Never push with `--no-verify` to get past it.
