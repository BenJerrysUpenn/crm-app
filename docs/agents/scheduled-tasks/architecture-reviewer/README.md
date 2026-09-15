# architecture-reviewer (Cowork Cloud routine)

Deployable source for the architecture PR reviewer — the third agent reviewer in the
taste-review pipeline. Lane `#452 [lane] Agent-based code review pipeline`; proven on
bj-finance by `#472`, rolled out here by `#496`.

- **`PROMPT.md` is the source of truth.** Deploy = name its path **on `origin/main` in this
  repository** inside the routine's one combined Instructions line; never hand-edit the
  routine's text box as the source (governance `#59`). The UI checklist is in
  [`../README-reviewers.md`](../README-reviewers.md).
- **One routine, `crm-app-reviewers`, runs all three reviewers in sequence.** This reviewer
  goes last.
- **Trigger:** GitHub `pull_request`, `All pull request events` with the draft filter set to
  `Is draft equals false`.
- **Its marker is `<!-- architecture-reviewer -->`.** Each reviewer has its own; the
  review-wait hook (`#470`) tells the three apart by marker.
- **Ground truth is only what is written, and only in this repository:**
  `README.md`, `docs/call-desk.md`,
  `docs/call-desk-do-not-call-policy.md`. **There is no `CLAUDE.md`** and no
  agent-instruction file of any kind.
  No outside best practice, and no rule from another repo. Every thread cites the rule
  (`file:line`) and the violation (`file:line`); a finding missing either is dropped before
  posting.
- **It never proposes a rule** (amendment 2026-09-15, Alina). The reviewer checks only that
  the architecture documents, in whatever shape they are, are followed. It cites a written
  rule and a violation, or it posts an APPROVE with zero threads. It never proposes rules,
  never comments on what rules are missing, and never grades against anything unwritten. The
  earlier `PROPOSED RULE:` thread is removed — the machinery is gone, not switched off.
- **Expect most PRs to be approved with zero threads, and read that as correct.** Per the
  `#472` ruling the reviewer grades only against what is written and never proposes a rule.
  This repo has no `CLAUDE.md` and no architecture rules document; what it has is a setup
  README with four real rules (`README.md:57` RLS on every `public` table, `:65` no public
  sign-up, `:70-85` the stage-write contract including "the app does **not** write
  `deals.boomerang_reason`", `:91` the board loads `archived = 0` only) and a 557-line
  call-desk spec carrying about a dozen code-shaped constraints. **A PR touching the call
  desk, the outreach tables, the stage-write path or Supabase access can draw a real
  twice-cited violation; a PR in `components/`, `time-app/` or `indeed-cv-downloader/` will
  draw an empty APPROVE, because no written sentence reaches it.** That is the reviewer
  working correctly, not failing to find work, and it stays that way until a human writes
  more down. Growing the documents is a human job and this routine plays no part in it.
- **One rule that governs this repo is written somewhere else.** Every RLS policy in this
  Supabase project must be `USING ((select public.is_manager()))`, never bare
  `is_manager()` — but that sentence lives in `bj-finance:docs/agents/system-bom.md`, not
  here, so the reviewer cannot cite it and will not raise it. Copying it into `README.md`
  is a human's edit.
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
      `<!-- architecture-reviewer -->` appears, roughly two minutes later.

**CI.** This repo has no GitHub Actions workflow today — `package.json` defines `lint`,
`typecheck` and `test` scripts, but nothing in CI runs them, so the deterministic check on a
PR here is the Vercel build. Merge rule is unchanged: **deterministic checks green first,
reviewer approvals advisory.**
