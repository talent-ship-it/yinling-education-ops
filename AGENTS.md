<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project rules

## Boundary and accounts

- Company profile: `insiderlead`. This repository is the filesystem boundary;
  do not access MAM, Personal, Forge, or sibling projects unless requested.
- CC Switch owns shared Skills and MCP definitions. Credentials remain
  company-specific and must never be copied into this repository.
- Run GitHub commands with `GH_CONFIG_DIR="$HOME/.github-profiles/insider-leads"`;
  verify login `talent-ship-it` and repository
  `talent-ship-it/yinling-education-ops` before a write.
- Before every commit, require repository-local Git identity
  `user.name=talent-ship-it` and
  `user.email=307850599+talent-ship-it@users.noreply.github.com`; never change
  global Git identity.
- Run Vercel with `--global-config "$HOME/.vercel-profiles/insider-leads"`;
  verify user `talent-2867`, scope `talent-2867s-projects`, and project
  `yinling-education-ops` before deployment or environment changes.
- The only approved Supabase target is project `orvsgisjjrzgtxuwwsms` in
  organization `fgnmdykxtthalhwspelu`. Run remote Supabase CLI commands through
  `"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- <command>`;
  never use a MAM Supabase target or an unwrapped remote command.
- Check Maton through
  `"$HOME/Documents/Codex/bin/codex-project-credential" check maton`. If a
  Keychain-backed check reports missing or denied inside the sandbox, request
  system-level execution and retry. Only a failed system-level check is a hard
  stop. External writes require explicit approval unless covered by the
  standing application-release authorization below.

## Standing application-release authorization

- Nixon authorized this workflow on 2026-10-22 for
  `talent-ship-it/yinling-education-ops`: after user-requested application
  changes pass relevant tests, review, and all required release checks,
  commit, push the task branch, open a PR, merge into the configured production
  branch, and verify the resulting production deployment. Do not wait for a
  separate go-live confirmation or ask for the same release approval again.
- Honor an explicit review-only, local-only, or do-not-publish request. Keep
  changes within the requested scope and retain account/target verification,
  required checks, and the reviewed GitHub-to-Vercel release flow. Production
  application code must be deployed by the GitHub merge, never a direct local
  Vercel deployment.
- Failed or unavailable required checks block release until resolved; report
  the exact blocker without bypassing the check. This standing authorization
  covers application-code releases, not unrelated external writes, production
  data/database mutations, credential changes, billing, or destructive actions.

## Git, worktree, and deletion safety

- Before changing files, run `git status --short --branch` and
  `git worktree list --porcelain`. Treat every pre-existing modified, deleted,
  or untracked path as protected user or other-session work.
- Never run parallel write tasks in the same checkout. Give each task a Codex
  Worktree or dedicated Git worktree on a unique `codex/<task>` branch; one
  branch belongs to one worktree. Use Codex Handoff between Local and Worktree.
- If protected work overlaps the task, or ownership is unclear, stop and ask.
  Do not run repo-wide formatters or generators in a dirty shared checkout.
- Never use `git reset --hard`, `git clean`, `git checkout --`, `git restore`,
  `git stash`, branch/worktree deletion, force push, or bulk deletion unless
  the user explicitly approves the exact target and action. Do not switch
  branches while protected changes exist.
- Delete only files created by the current task or exact user-approved paths
  after verifying each target. Untracked files and another session's artifacts
  are protected, not cleanup candidates.
- Stage only explicit task paths; never use `git add .` or `git add -A` in a
  dirty checkout. Before committing, inspect `git diff --cached --check`,
  `git diff --cached`, and `git status --short`.
- At handoff, report the worktree, branch, changed paths, tests, and commit
  status. Leave every unrelated change untouched.

## Engineering and data

- This is a Next.js education-operations app. Treat student, teacher, contract,
  Jiaowubao, and BigBlueButton data as confidential; use synthetic test data.
- Use `npm run lint`, `npm run build`, and focused tests; run `npm test` when the
  affected area warrants the full suite.
- Preserve tracked and untracked work. Make the smallest scoped change, stage
  explicit paths only, review the staged diff, and run
  `git diff --cached --check` before commit.
- Never expose or commit `.env*`, tokens, API payloads, OAuth material, database
  dumps, service-role keys, or private customer exports.
- Report only checks and remote results that were actually verified.
