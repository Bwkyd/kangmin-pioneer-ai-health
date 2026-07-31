#!/usr/bin/env node

import { resolve } from "node:path";

import { createApplication } from "../app/composition-root.js";
import { DomainError, exitCodeForCode } from "../kernel/errors.js";
import { failure, type CommandResult } from "../kernel/result.js";

const HELP = `抗敏先锋患者 CLI（Patient Record MVP）

用法：
  kangmin                         启动 Agent（本 MVP 明确返回未实现）
  kangmin agent                   对话与智能分析
  kangmin record symptom add      新增症状与 TNSS
  kangmin record symptom list     查询本人症状记录
  kangmin record symptom show ID  查询本人单条记录
  kangmin record symptom update ID 更新本人记录
  kangmin browse                  浏览环境与已发布内容
  kangmin account                 管理账号、授权和设置

当前真实可用：
  record symptom add|list|show|update

身份：
  通过 KANGMIN_SESSION_TOKEN 传递不透明会话令牌。
  CLI 不接受 patient_id/user_id。

机器输出：
  添加 --json 后 stdout 只输出一个 JSON 对象。
`;

const NUMBER_OPTIONS = new Set([
  "nasalCongestion",
  "nasalItching",
  "sneezing",
  "runnyNose",
  "expectedRevision"
]);

const OPTION_NAMES: Record<string, string> = {
  "--local-date": "localDate",
  "--nasal-congestion": "nasalCongestion",
  "--nasal-itching": "nasalItching",
  "--sneezing": "sneezing",
  "--runny-nose": "runnyNose",
  "--notes": "notes",
  "--idempotency-key": "idempotencyKey",
  "--expected-revision": "expectedRevision"
};

interface ParsedCommand {
  command: string;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
}

function parse(argv: string[]): ParsedCommand {
  const json = argv.includes("--json");
  const filtered = argv.filter((value) => value !== "--json");
  const help = filtered.includes("--help") || filtered.includes("-h");
  if (help) {
    return { command: "help", input: {}, json, help: true };
  }

  if (filtered.length === 0) {
    return { command: "agent", input: {}, json, help: false };
  }

  const [group, resource, action, positional, ...rest] = filtered;
  if (group !== "record") {
    if (filtered.length !== 1) {
      return {
        command: filtered.join(" "),
        input: {},
        json,
        help: false
      };
    }
    return { command: group ?? "", input: {}, json, help: false };
  }

  const command = [group, resource, action].filter(Boolean).join(" ");
  const input: Record<string, unknown> = {};
  const optionTokens =
    action === "show" || action === "update"
      ? rest
      : [positional, ...rest].filter((value): value is string => value !== undefined);

  if ((action === "show" || action === "update") && positional !== undefined) {
    input.id = positional;
  }

  for (let index = 0; index < optionTokens.length; index += 2) {
    const option = optionTokens[index];
    const value = optionTokens[index + 1];
    const key = option === undefined ? undefined : OPTION_NAMES[option];
    if (key === undefined || value === undefined) {
      input.__parseError = `无效或缺少值的参数：${option ?? "(empty)"}`;
      break;
    }
    input[key] = NUMBER_OPTIONS.has(key) ? Number(value) : value;
  }

  return { command, input, json, help: false };
}

function human(result: CommandResult): string {
  if (!result.ok) {
    return `${result.error.code}: ${result.error.message}`;
  }
  if (
    typeof result.data === "object" &&
    result.data !== null &&
    "items" in result.data
  ) {
    const items = (result.data as { items: unknown[] }).items;
    return items.length === 0
      ? "暂无症状记录"
      : JSON.stringify(items, null, 2);
  }
  return JSON.stringify(result.data, null, 2);
}

export async function runCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const parsed = parse(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (typeof parsed.input.__parseError === "string") {
    const result = failure(
      parsed.command,
      new DomainError("command_invalid", parsed.input.__parseError)
    );
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`command_invalid: ${parsed.input.__parseError}\n`);
    }
    return 2;
  }

  const databasePath = resolve(
    environment.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );

  let application;
  try {
    application = createApplication(databasePath);
  } catch (error) {
    const result = failure("system bootstrap", error);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    }
    return exitCodeForCode(result.error.code);
  }

  try {
    const result = await application.execute({
      command: parsed.command,
      input: parsed.input,
      sessionToken: environment.KANGMIN_SESSION_TOKEN
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      process.stdout.write(`${human(result)}\n`);
    } else {
      process.stderr.write(`${human(result)}\n`);
    }
    return result.ok ? 0 : exitCodeForCode(result.error.code);
  } finally {
    application.close();
  }
}

process.exitCode = await runCli(process.argv.slice(2));
