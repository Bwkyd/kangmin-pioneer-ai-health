# Repository Guidelines

## Project Structure & Module Organization

- `src/app/` contains the product UI. `page.tsx` owns the interactive single-page experience, `layout.tsx` defines metadata, and `globals.css` contains the visual system.
- `public/` stores shipped assets such as the brand banner and social preview.
- `src/worker/`, `src/db/`, and `drizzle/` contain the Cloudflare worker entry, database code, and migrations. Project-specific build code lives in `src/build/`. Keep example D1 code under `examples/d1/` separate from production paths.
- `tests/` contains server-rendering checks. `docs/客户资料/` contains private customer requirements, quotations, and clinical references; never expose these files through `public/`.
- Treat `dist/`, `.vinext/`, `.wrangler/`, and `node_modules/` as generated content. Do not edit or commit them.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer.

- `npm install` installs the locked dependencies.
- `npm run dev` starts the local vinext development server.
- `npm run build` creates the Cloudflare-compatible production bundle.
- `npm test` builds the project, then runs `tests/*.test.mjs` with Node's test runner.
- `npm run lint` checks TypeScript, React, and accessibility rules.
- `npm run db:generate` generates Drizzle migrations after schema changes.

## Coding Style & Naming Conventions

Follow the existing TypeScript/TSX style: two-space indentation, double quotes, semicolons, and small focused functions. Name React components with `PascalCase`, variables and handlers with `camelCase`, and CSS classes with `kebab-case`. Reuse existing design tokens and mobile-first layout patterns before adding new styles. Keep user-facing Chinese copy direct and medically cautious.

## Testing Guidelines

Use Node's built-in `node:test` and name files `*.test.mjs`. Test observable rendered behavior rather than implementation details. Update rendering assertions whenever page titles, notices, or navigation change. Before submitting, run `npm run build`, `npm test`, and `npm run lint`; document any known failure rather than hiding it.

## Commit & Pull Request Guidelines

Use short imperative commit subjects matching history, such as `Add knowledge source notice` or `Fix mobile navigation spacing`. Keep each commit focused. Pull requests should explain the user-visible outcome, list verification commands, link the related task, and include before/after screenshots for UI changes.

## Security & Clinical Rules

Do not commit secrets or alter `.openai/hosting.json` identifiers casually. The syndrome-differentiation flow must use the approved fixed decision tree/rule engine first; the language model explains the rule result and retrieves approved knowledge, but must not invent diagnoses or silently change clinical rules. Preserve the existing medical-reference and outpatient-diagnosis disclaimers.
