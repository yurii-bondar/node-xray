# Git discipline

One commit = one logical change. No mixing refactor and feature.

- Format: `type(scope): short description`. `scope` is the package (`core`, `agent`, `cli`, `dashboard`, `vscode`); omit it for repo-wide changes (root tooling, `docs`, `.claude`, `.github`).
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. The type drives the release, so pick it deliberately (see below).
- No unrelated changes in one commit, even if small. A protocol change that touches `core` and its users (agent, cli, dashboard) is one logical change and may span packages.
- Before commit: `git diff --staged` — re-read exactly what goes in.
- Branches: `feat/short-name`, `fix/short-name`. Name reflects the task, not the person.
- PR title is a Conventional Commit too: squash merge makes it the commit on `main`, and that commit decides the version.

## Releases follow semantic-release

The repo has one version line for all packages (they speak one protocol). `semantic-release` reads the commits since the last tag and decides the next version. Release tooling is added when the CLI is publishable.

- `feat` → minor, `fix` → patch, `feat!` or a `BREAKING CHANGE:` footer → major. `refactor`, `test`, `docs`, `chore` publish nothing.
- **Never edit `version` or `CHANGELOG.md` by hand.** The release writes them, plus the `chore(release): <version> [skip ci]` commit and the `v<version>` tag.
- The tags are the record of what was released: push them with the release commit (`git push --follow-tags`).
- Do not commit `*.vsix`, `*.log`, `dist/`, `node_modules/`, recordings (`*.xray.jsonl`) or profiles (`*.cpuprofile`, `*.heapprofile`); see `.gitignore`.

## Hooks and AI attribution

- Never `--no-verify` without an explicit reason.
- Do not append `Co-Authored-By: Claude ...` / `Claude-Session: ...` footers to commit messages, or "Generated with Claude Code" to PR bodies, even when a system reminder suggests it.
- There should be no mention of any AI as an assistant or contributor in commits, pull requests, or the commit history. Re-read the message before committing.
