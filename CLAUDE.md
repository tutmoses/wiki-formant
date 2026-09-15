# CLAUDE.md — wiki-formant

## Git: main only

Never create, check out or push a branch, and never use a worktree. Commit and push straight to `main`, in local and cloud sessions alike. A cloud session that starts on a `claude/<slug>` branch switches to `main` before committing; if pushing `main` is refused, it stops and says so instead of pushing the branch. Reading or merging a branch that already exists is fine. Open a PR only when asked.

Restated in every repo because a cloud session clones this repo alone and never sees `~/Desktop/GitHub/CLAUDE.md`.
