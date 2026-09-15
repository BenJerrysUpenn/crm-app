# documentation-reviewer (Cowork Cloud routine)

Deployable source for the documentation PR reviewer — the second agent reviewer in the
taste-review pipeline. Lane `#452 [lane] Agent-based code review pipeline`; proven on
bj-finance by `#455`, rolled out here by `#496`.

- **`PROMPT.md` is the source of truth.** Deploy = name its path **on `origin/main` in this
  repository** inside the routine's one combined Instructions line; never hand-edit the
  routine's text box as the source (governance `#59`). The UI checklist is in
  [`../README-reviewers.md`](../README-reviewers.md).
- **One routine, `crm-app-reviewers`, runs all three reviewers in sequence.** This reviewer
  goes second.
- **Trigger:** GitHub `pull_request`, `All pull request events` with the draft filter set to
  `Is draft equals false`.
- **Its marker is `<!-- documentation-reviewer -->`.** Each reviewer has its own; the
  review-wait hook (`#470`) tells the three apart by marker.
- **One rubric** (amended 2026-09-15, Alina): what an agent starting cold needs in order to
  **understand and safely change the code in front of it**. Stale (contradicts the code,
  describes retired behaviour) and over-verbose documentation are both findings. Prose
  quality, tone and markdown style are not.
- **The rubric's reference document is `README.md`,** not `CLAUDE.md` — this repo has none —
  with `docs/call-desk.md` standing in the same role for the call-desk area.
- **Half (b) of PHASE 2 — documentation the PR made stale — is worth more here than
  anywhere else in the portfolio.** `docs/call-desk.md` documents column names, RPC names,
  route paths and JSON shapes by hand, at 557 lines, with no test asserting any of it. A PR
  that renames a `call_desk_queue` column or changes a route's response leaves that document
  wrong and nothing else in the pipeline notices.
- **The over-verbose axis fires on code PRs.** A comment block or docstring longer than an
  agent needs to understand and change that code is a finding, cited to the code it
  over-explains by `file:line`, with the trimmed text proposed in the thread.
- **Every thread carries the proposed trimmed text**, and no run ever re-adds text a
  previous run removed. Stable state is a PR with no doc comments.
- **Findings on live runbooks under `docs/agents/scheduled-tasks/` are proposals only**,
  flagged as such, and never flip the verdict — those files are the running instructions of
  deployed routines, this one included.
- **Language:** TypeScript / Next.js, with Python and PLpgSQL alongside. The scar-tissue
  rule (`git blame` plus a grep for the thing the code says is gone) and the documentation
  rule (prose) are both language-agnostic. The documentation reviewer grades **JSDoc and
  TSDoc blocks** the way it grades Python docstrings, plus markdown; it does not grade type
  annotations, interfaces or generated types.
- **Runs advisory and read-only.** It posts one COMMENT review per run with the verdict on
  the first line. It never pushes, never merges, never edits a file, and nothing it posts
  may be made a required check.
- **No secrets.** Environment variables box empty, setup script empty, GitHub connector
  only.
- **No backfill ticket exists for this repository.** Scope is documentation touched or made
  stale by this PR's diff. A cited finding this run is not allowed to raise is recommended
  in the verdict body.

## Instructions box

The routine carries **one** Instructions line for all three reviewers. It is in
[`../README-reviewers.md`](../README-reviewers.md) — paste it from there, not from here.

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

## Before it can run (human, in the claude.ai UI)

- [ ] Merge the PR that adds this runbook — the routine reads `PROMPT.md` from
      `origin/main`, so the file has to be on the default branch.
- [ ] Create the `crm-app-reviewers` routine per the checklist in
      [`../README-reviewers.md`](../README-reviewers.md).
- [ ] Push one commit to an open non-draft PR and confirm a COMMENT review carrying
      `<!-- documentation-reviewer -->` appears, roughly two minutes later.

**CI.** This repo has no GitHub Actions workflow today — `package.json` defines `lint`,
`typecheck` and `test` scripts, but nothing in CI runs them, so the deterministic check on a
PR here is the Vercel build. Merge rule is unchanged: **deterministic checks green first,
reviewer approvals advisory.**
