# PR reviewers on `crm-app` — one routine, three reviewers

Three agent reviewers run on every non-draft pull request in this repository: the
**scar-tissue reviewer**, the **documentation reviewer** and the **architecture reviewer**.
They are the pipeline proven on bj-finance by `#453`, `#455` and `#472` (lane `#452
[lane] Agent-based code review pipeline`), rolled out here by `#496`.

**There is ONE routine, not three.** It reads all three runbooks from `origin/main` and runs
them in sequence in a single run, each posting its own COMMENT review under its own marker.

| Reviewer | Runbook | Marker |
|---|---|---|
| Scar-tissue | [`scar-tissue-reviewer/PROMPT.md`](scar-tissue-reviewer/PROMPT.md) | `<!-- scar-tissue-reviewer -->` |
| Documentation | [`documentation-reviewer/PROMPT.md`](documentation-reviewer/PROMPT.md) | `<!-- documentation-reviewer -->` |
| Architecture | [`architecture-reviewer/PROMPT.md`](architecture-reviewer/PROMPT.md) | `<!-- architecture-reviewer -->` |

Each has its own README beside its `PROMPT.md`. **`PROMPT.md` is the source of truth** for
each reviewer: deploy = name its path on `origin/main` inside the one Instructions line
below; never hand-edit the routine's text box as the source (governance `#59`).

## The Instructions line — paste this verbatim into the routine

> In the `BenJerrysUpenn/crm-app` checkout, run `git fetch origin main`. Then, for each
> runbook in this order — `docs/agents/scheduled-tasks/scar-tissue-reviewer/PROMPT.md`,
> `docs/agents/scheduled-tasks/documentation-reviewer/PROMPT.md`,
> `docs/agents/scheduled-tasks/architecture-reviewer/PROMPT.md` — read it with `git show
> origin/main:<path>` (never the working-tree copy) and follow the section below its
> second `---` separator line, completing one reviewer's review before starting the
> next. Everything above each second separator is maintainer notes and a checklist, not
> instructions for you. If any read fails or a file has fewer than two `---` separators,
> STOP that reviewer and continue with the next; if all three fail, do nothing. Review
> only the pull request that triggered this run.

That is the whole of the Instructions box. One line, three runbooks, in that order.

## Routine UI checklist (human, in the claude.ai UI)

An agent cannot create a routine or configure a trigger; all of this is Alina's.

- [ ] **Merge the PR that adds these runbooks.** The routine reads each `PROMPT.md` from
      `origin/main` in the attached checkout, so the files have to be on the default branch
      before the routine can do anything.
- [ ] **Name:** `crm-app-reviewers`.
- [ ] **Attached repo:** `BenJerrysUpenn/crm-app` — **only**. Attaching extra repositories
      adds checkouts, **not** triggers (`#453`, 2026-09-15): a routine watches exactly one
      repository.
- [ ] **Instructions box:** the single line above, nothing else.
- [ ] **Connectors:** **GitHub** only. No Gmail, no Trello, no Slack, no QBO.
- [ ] **Environment:** variables box **empty**, setup script **empty**, network access
      default. This routine holds no secrets, which is the point.
- [ ] **Trigger:** GitHub → repository `BenJerrysUpenn/crm-app` → **All pull request
      events**, with the draft filter set to **`Is draft equals false`**.
- [ ] **Save, then test:** push one commit to an open non-draft PR and confirm **three**
      COMMENT reviews appear, roughly two minutes later, one per marker.

No Claude GitHub App install is needed: `#453` proved on 2026-09-15 that the native
`pull_request` trigger fires without one. **No account, no bot identity and no PAT is to be
created for this** — by ruling, the verdict lives in words on the first line of each review
body instead of in a commit status.

## The rules this pipeline runs under

- **Advisory, always.** Nothing these reviewers post may be made a required status check.
  They never push, never merge, never edit a file, never edit an issue body, never close
  anything.
- **Merge rule unchanged:** CI green first; reviewer approvals are advisory.
- **10-cycle cap.** A cycle is one reviewer run plus the implementing agent's fix-or-qualify
  pass. At 10 the reviewer stops reviewing and elevates to the human.
- **8 inline threads per review, maximum.** Anything held back is counted in the verdict.
- **Every finding is cited, or it is dropped** — blame for scar tissue, `file:line` in the
  code for documentation, and *two* citations (the rule and the violation) for architecture.
  A candidate that cannot be cited is dropped before posting, not softened.
- **The architecture reviewer never proposes a rule** (amendment 2026-09-15). It cites a
  written rule and a violation, or it approves with zero threads. It never comments on what
  rules are missing.
- **Verdicts are `COMMENT` reviews**, never `APPROVE`/`REQUEST_CHANGES`: GitHub refuses
  those from the account that opened the PR, and no bot identity is to be created to get
  around it.
- **Read from `origin/main`, review the PR head.** The runbook and every repo-level document
  a reviewer grades against come from `origin/main`; the diff, the blame and the code under
  review come from the PR head.

## What running three reviewers in one session changes

Three reviewers now share a sandbox and a working directory, so two mechanics that were
per-routine on bj-finance are per-repo here, and both are load-bearing:

- **Separate worktrees.** `/tmp/pr-<N>-scar`, `/tmp/pr-<N>-doc`, `/tmp/pr-<N>-arch`, each
  removed with `git worktree remove` and never `rm -rf`. An unsuffixed path collides with a
  sibling in the same run; a deleted directory leaves a stale registration that breaks the
  next `worktree add`.
- **Separate markers.** Each reviewer counts, answers and re-raises only reviews carrying
  its own marker. The review-wait hook (`#470`) tells the three apart by marker alone and
  releases the implementing agent only when every expected marker has landed on the head
  SHA.

A reviewer that cannot run stands down on its own and the next one still runs. One failure
is not three; only all three failing means the run does nothing.

Because the trigger is **All pull request events** (the UI has a single-select event and no
action filter), each reviewer's PHASE 0 drops any action other than `opened`, `synchronize`
and `reopened`. The cost is harmless no-op runs on `closed`, `labeled` and `edited`.

## Deploy

This repository deploys through **Vercel previews** — every branch gets a preview URL, and
the previews are SSO-gated with no CLI path, so an agent cannot open one and end-to-end
checks are Alina's on the preview. **A docs-only merge that adds or changes these runbooks
is harmless:** nothing under `docs/` is imported by the Next.js build or read at runtime.
What it *is* load-bearing for is the routine: the routine reads this runbook from
`origin/main`, so a change only takes effect once it is merged.

**This repo has no GitHub Actions workflow today** — `package.json` defines `lint`,
`typecheck` and `test` scripts, but nothing in CI runs them, so "CI green first" here means
whatever checks the repo actually has, which is currently the Vercel build. That does not
change the merge rule: **deterministic checks first, reviewer approvals advisory.**

### Root cause recorded 2026-09-15 — why it reads `origin/main`

The cloud routine checks out the **PR head branch** on a `pull_request` trigger, **not
`main`**. A PR whose branch was cut before this runbook landed therefore does not contain
it, and the run stops by design — correctly, but silently. Found in the live test at
`2026-09-15T13:50Z` on bj-finance: the architecture reviewer fired on `#471`, whose branch
predates the runbooks, could not find the runbook in its checkout, and stood down. The
documentation reviewer survived the same trigger only because its PHASE flow fetches `main`
first.

The Instructions line is the fix. **The split to remember: the runbook and every repo-level
document the reviewer grades against come from `origin/main`; the diff, the blame and the
code under review come from the PR head.**
