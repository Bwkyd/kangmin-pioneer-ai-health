# Repository Guidelines

## Project Structure & Module Organization

- `legacy/` contains the complete pre-CLI Vinext/Cloudflare product. Its `app/`, `public/`, `worker/`, `db/`, `drizzle/`, `build/`, and `tests/` paths retain their original roles.
- `src/` is reserved for the new CLI-first core and thin frontend shell. Do not import business state or framework-specific modules from `legacy/`; treat the legacy app as a behavior and acceptance reference.
- `docs/客户资料/` contains private customer requirements, quotations, and clinical references; never expose these files through either frontend's public assets.
- Treat `legacy/dist/`, `legacy/.vinext/`, `legacy/.wrangler/`, and `legacy/node_modules/` as generated content. Do not edit or commit them.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer.

Run the legacy commands from `legacy/`.

- `cd legacy && npm ci` installs the exact locked dependencies on a clean checkout.
- `npm install` is used only when intentionally changing legacy dependencies.
- `npm run dev` starts the legacy vinext development server.
- `npm run build` creates the legacy Cloudflare-compatible production bundle.
- `npm test` builds the legacy project, then runs its Node test suite.
- `npm run lint` checks the legacy TypeScript, React, and accessibility rules.
- `npm run db:generate` generates legacy Drizzle migrations after schema changes.

## Coding Style & Naming Conventions

Follow the existing TypeScript/TSX style: two-space indentation, double quotes, semicolons, and small focused functions. Name React components with `PascalCase`, variables and handlers with `camelCase`, and CSS classes with `kebab-case`. Keep user-facing Chinese copy direct and medically cautious. New `src/` code must expose business behavior through CLI commands before a frontend shell consumes it.

## Testing Guidelines

Use Node's built-in `node:test` and name files `*.test.mjs`. Test observable behavior rather than implementation details. Before submitting a legacy-only change, run `cd legacy && npm run build && npm test && npm run lint`; document any known failure rather than hiding it.

## Commit & Pull Request Guidelines

Use short imperative commit subjects matching history, such as `Add knowledge source notice` or `Fix mobile navigation spacing`. Keep each commit focused. Pull requests should explain the user-visible outcome, list verification commands, link the related task, and include before/after screenshots for UI changes.

## Agent Automation Workflow

- Every feature, fix, refactor, or automation change starts from a confirmed GitHub Issue with scope, non-scope, acceptance criteria, risk, and verification.
- Use branches named `codex/issue-<number>-<slug>`. Use `scripts/worktree-create.sh` for multi-file or medium/high-risk tasks.
- Keep each Agent's writable file ownership non-overlapping. Database migrations, shared types, permissions, clinical rules, and core interfaces have one integration owner.
- Copy `docs/plans/TEMPLATE.md` to `docs/plans/active/` for multi-step work and keep evidence, blockers, branch, PR, and candidate SHA current.
- Do not push directly to `main`. Open a Draft PR and require the `quality` CI check.
- Run `bash scripts/install-git-hooks.sh` after cloning so the shared Git hooks block accidental direct pushes to `main`. Treat this as a local fallback, not server-side branch protection.
- CI, readiness, or narrow tests do not authorize merge, deployment, Issue closure, or customer acceptance.
- After merge, verify the PR state and final Git tree. Run `scripts/worktree-audit.sh` before requesting permission to remove a worktree or branch.
- Record only proven cross-task patterns and measurable metrics in `memory/dev-loop-patterns.md` and `memory/dev-loop-metrics.md`.

## Security & Clinical Rules

Do not commit secrets or alter `.openai/hosting.json` identifiers casually. The syndrome-differentiation flow must use the approved fixed decision tree/rule engine first; the language model explains the rule result and retrieves approved knowledge, but must not invent diagnoses or silently change clinical rules. Preserve the existing medical-reference and outpatient-diagnosis disclaimers.
