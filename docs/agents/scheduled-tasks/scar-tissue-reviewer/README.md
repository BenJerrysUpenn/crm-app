# scar-tissue-reviewer (Cowork Cloud routine)

Deployable source for the scar-tissue PR reviewer — the first agent reviewer in the
taste-review pipeline. Lane `#452 [lane] Agent-based code review pipeline`; proven on
bj-finance by `#453`, rolled out here by `#496`.

- **`PROMPT.md` is the source of truth.** Deploy = name its path **on `origin/main` in this
  repository** inside the routine's one combined Instructions line; never hand-edit the
  routine's text box as the source (governance `#59`). The UI checklist is in
  [`../README-reviewers.md`](../README-reviewers.md), and a short per-reviewer version sits
  in `PROMPT.md` above the second `---`.
- **One routine, `crm-app-reviewers`, runs all three reviewers in sequence.** This reviewer
  goes first.
- **The runbook lives here, not in Software-Factory,** because a cloud routine's GitHub
  access is scoped to its attached repo. The routine must attach `crm-app` to run
  `git blame`, so it cannot read a prompt out of any other repo, on any branch. The decision
  record stays in Software-Factory; the runbook travels with the code it reviews, which is
  why every repo gets its own copy.
- **Trigger:** GitHub `pull_request`, `All pull request events` with the draft filter set to
  `Is draft equals false`. No cron, no polling, no opt-in label — all three were tried on
  `#453` and ruled out, and `PROMPT.md` records why so they are not reinvented.
- **Its marker is `<!-- scar-tissue-reviewer -->`.** Each reviewer has its own; the
  review-wait hook (`#470`) tells the three apart by marker and releases the implementing
  agent only when every expected reviewer has weighed in on the head SHA.
- **The rule:** the codebase is only what it is right now. Code that carries history instead
  of function is scar tissue — compat shims for something gone, "used to be X" comments,
  commented-out paths, defensive code for a fixed bug, dead flags.
- **The guardrail:** every comment carries a `git blame` citation (short SHA, author date,
  commit subject), the claim phrased as a reading, and a named thing to verify. **It never
  says "delete this."** A candidate it cannot cite is dropped before posting, not softened.
- **Its worktree is `/tmp/pr-<N>-scar`,** removed with `git worktree remove`. The three
  reviewers share a sandbox, so an unsuffixed path collides.
- **Language:** TypeScript / Next.js, with Python and PLpgSQL alongside. The scar-tissue
  rule (`git blame` plus a grep for the thing the code says is gone) and the documentation
  rule (prose) are both language-agnostic. The documentation reviewer grades **JSDoc and
  TSDoc blocks** the way it grades Python docstrings, plus markdown; it does not grade type
  annotations, interfaces or generated types.
- **Runs advisory and read-only on this repo's code.** It posts one COMMENT review per run
  with the verdict in words plus blame-cited inline threads. It never pushes, never merges,
  never says "delete this", and nothing it posts may be made a required check.
- **No secrets.** Environment variables box empty, setup script empty, GitHub connector
  only. There is no commit status and no PAT — see `PROMPT.md` for why.
- **No backfill ticket exists for this repository.** Scope is the PR diff. A cited finding
  this run is not allowed to raise is recommended in the verdict body; opening a backfill
  ticket for `crm-app` is a human's call.

## Instructions box

The routine carries **one** Instructions line for all three reviewers. It is in
[`../README-reviewers.md`](../README-reviewers.md) — paste it from there, not from here, so
there is only one copy to keep right.

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
      `origin/main` in the attached checkout, so the file has to be on the default branch.
- [ ] Create the `crm-app-reviewers` routine per the checklist in
      [`../README-reviewers.md`](../README-reviewers.md).
- [ ] Push one commit to an open non-draft PR and confirm a COMMENT review carrying
      `<!-- scar-tissue-reviewer -->` appears, roughly two minutes later.

**CI.** This repo has no GitHub Actions workflow today — `package.json` defines `lint`,
`typecheck` and `test` scripts, but nothing in CI runs them, so the deterministic check on a
PR here is the Vercel build. Merge rule is unchanged: **deterministic checks green first,
reviewer approvals advisory.**
