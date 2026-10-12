# ponytail — how we build here

> He says nothing. He writes one line. It works.
>
> The ruleset for ANY AI coding agent working in this repo (part of the
> ECODrIx platform). Write the least code that works, like a senior dev paged at 3am one too many times. Adapted
> from [ponytail](https://ponytail.dev) (MIT).

Read this before writing any code. It governs HOW you build here, not WHAT.

---

## The rule

Write only what the task needs. Never cut validation, error handling, security,
or accessibility. The code ends up small because it is **necessary, not golfed**.

## The ladder

Understand the problem first — read the code the change touches and trace the
real flow. Then stop at the **first rung that holds**:

1. **Does this need to exist?** Speculative need → skip it. (YAGNI)
2. **Already in this codebase?** Reuse the helper, util, service, or pattern
   that already lives here. Don't rewrite.
3. **Standard library does it?** Use it.
4. **Native platform feature covers it?** Use it (`<input type="date">` over a
   picker lib; SQL over a hand-rolled loop).
5. **An already-installed dependency solves it?** Use it. **Do not add a new
   one.**
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

Lazy about the solution, never about reading. The ladder runs _after_ you
understand the problem, not instead of it.

## Non-negotiable (never simplified away)

- **Trust-boundary validation** — validate anything crossing a boundary
  (request bodies, webhook payloads, external/tenant input).
- **Data-loss handling** — migrations, deletes, writes: safe and reversible.
- **Security** — authz/tenant isolation, parameterized queries, secrets never
  logged, scoped credentials.
- **Error handling** — real failure paths, not swallowed.
- **Accessibility** — for any UI.

Lazy, not negligent.

---

## How this maps to ECODrIx (the local ladder)

This workspace already has the primitives. Reach for them before inventing:

- **Rung 2 — reuse what's here first.** Before a new endpoint/service/component:
  - CRM/data access → the **`ErixAdapter`** (`postgres-adapter.ts`), never raw
    drizzle in a route. Tenant scope via `resolveDataAccess` / `req.orgId`.
  - External/dev auth → the shared **`externalAuth(scope)`** gate, not inline
    key checks.
  - Direct channel send → **`/infra/connect/send/{channel}`**. Fire an event →
    **`/events/trigger`**. Define a trigger → **`/crm/custom-events`**. Don't
    add a parallel surface.
  - Frontend calls → the isomorphic **`@ecodrix/erix-api` SDK**, not bespoke
    fetches.
  - Conversations/inbox → **`ConversationSDK`** (one inbox, all channels).
  - Background work → the existing **queue registry** (`shared/lib/erix/queues`).
- **Fewer things, no duplicates.** Consolidate rather than add a second way to
  do the same job. If two surfaces overlap, delete one — pick the canonical
  version and migrate. (This is why `/actions/execute`, `/crm/events/emit`, the
  `/events` registry, and the email Bearer path were removed.)
- **Migrations before deploy.** Apply SQL to the DB _first_, then deploy code
  that reads the new columns. Idempotent (`ADD COLUMN IF NOT EXISTS`), with a
  down-path. Never let code expect a column the DB lacks.
- **Verify locally.** Run diagnostics after every change; run the relevant
  tests before claiming done. Don't add tests unless the task is a feature/bug
  fix that warrants them.
- **Ownership split.** The agent owns in-repo code, verified locally. The human
  owns ops/decisions: pushes, migrations-in-prod, deploys, prod env, live
  payment tests, security config, scope calls.

---

## Intensity

Default is **full**.

- **lite** — build what was asked; name the lazier alternative in one line; the
  human picks.
- **full** — the ladder, enforced. Stdlib/native first. Shortest diff, shortest
  explanation.
- **ultra** — YAGNI extremist. Ship the one-liner and challenge the rest of the
  requirement in the same breath.
- **off** — ruleset disabled.

## Deferred shortcuts — the debt ledger

When you deliberately defer something (a real need the task didn't cover), leave
a single marker so "later" doesn't become "never":

```
// ponytail: <what was skipped and why> — <the fuller thing to revisit>
```

Collect these before shipping a milestone; don't let them accumulate silently.

## Working commands (conventions for chat)

- **review** — scan the current diff for over-engineering; hand back a delete-list.
- **audit** — scan the repo for bloat/duplicate surfaces.
- **debt** — collect the `ponytail:` markers into a ledger.
- **gain** — report what a change removed (lines/deps/surfaces cut).

---

## Why

Measured on a real FastAPI + React repo: ~54% less code, ~22% fewer tokens, ~20%
lower cost, ~27% faster — **100% of safety guards kept**. The best code is the
code never written: zero bugs, zero CVEs, infinite uptime in the code that
doesn't exist.

The whole idea, in one line: **your agent reaches for fifty lines; the job needs
one.**

## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows.
Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Skills like /qa, /ship, /review, /investigate, and /browse become available after install.
Use /browse for all web browsing (Aside first, the bundled gstack browser as fallback). Use ~/.claude/skills/gstack/... for gstack file paths.
