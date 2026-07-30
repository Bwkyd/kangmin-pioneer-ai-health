# 抗敏先锋 AI 鼻健康管理系统

本仓库正在转向 CLI-first 架构：新的业务内核和薄前端壳从 `src/` 开始，原 Vinext/Cloudflare 产品完整保留在 `legacy/` 作为需求、行为和验收参考。

客户报价、需求原文、决策树研究资料和品牌素材统一存放在 `docs/客户资料/`。

## Prerequisites

- Node.js `>=22.13.0`

## Repository Shape

- `src/`：新的 CLI-first 内核与薄前端壳，禁止直接依赖旧实现内部模块。
- `legacy/`：迁移前的完整产品源码、配置、迁移、静态资源和测试。
- `docs/`：需求、决策、计划和运行手册；客户私密资料不会公开发布。
- `scripts/`、`.github/`：仓库级开发与交付治理。
- `.openai/hosting.json`：旧 Sites 项目的托管标识，保持在仓库根目录。

四组 CLI 的命令边界和能力目录从 `src/cli.mjs` 开始实现；这不改变任何临床规则，未获批准的临床候选默认不可用。

## CLI Quick Start

```bash
npm run build
npm test
node src/cli.mjs --help
node src/cli.mjs control capability list --json
```

命令模型和 Issue 归属见
[docs/architecture/four-group-cli.md](docs/architecture/four-group-cli.md)。

## Legacy Quick Start

```bash
cd legacy
npm ci
npm run dev
npm run check
```

首次克隆后，在仓库根目录执行 `bash scripts/install-git-hooks.sh`。

## Agent Development

All changes start from a confirmed GitHub Issue. Use an isolated branch and, for
multi-file or higher-risk work, an isolated worktree:

```bash
scripts/worktree-create.sh 123 short-slug
cd .worktrees/issue-123-short-slug
cd legacy
npm ci
```

Open a Draft PR using the repository template. The `quality` CI check runs lint,
build, and tests. Passing CI does not authorize merge or deployment; those
actions still require explicit approval.

Before cleanup, run:

```bash
scripts/worktree-audit.sh .worktrees/issue-123-short-slug
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[the Agent development runbook](docs/runbooks/agent-development.md).
GitHub protection status and the local fallback are documented in
[the repository governance runbook](docs/runbooks/github-governance.md).

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

The legacy app keeps the ready-to-use helpers in `legacy/app/chatgpt-auth.ts`.
When that site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Legacy Useful Commands

Run these commands from `legacy/`:

- `npm run dev`: start legacy local development
- `npm run build`: verify the legacy vinext build output
- `npm test`: build the legacy product and run its complete test suite
- `npm run check`: run legacy lint, production dependency audit, build, and tests
- `npm run db:generate`: generate legacy Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
