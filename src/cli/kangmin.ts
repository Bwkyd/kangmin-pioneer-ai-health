#!/usr/bin/env node

import { resolve } from "node:path";

import { createApplication } from "../app/composition-root.js";
import { DomainError, exitCodeForCode } from "../kernel/errors.js";
import { failure, type CommandResult } from "../kernel/result.js";

const HELP = `抗敏先锋患者 CLI（Agent + Patient Record MVP）

用法：
  kangmin                         启动确定性 Agent 安全会话
  kangmin agent                   对话与智能分析
  kangmin record                  管理自己的健康记录
  kangmin browse                  浏览环境与已发布内容
  kangmin account                 管理账号、授权和设置

record 命令：
  record symptom add|list|show|update|delete
  record profile show|update
  record exposure add|list|show|update|delete
  record medication add|list|show|update|delete
  record overview
  record calendar --month YYYY-MM
  record trend --from YYYY-MM-DD --to YYYY-MM-DD

agent 命令：
  agent start
  agent continue <session-id> --expected-revision <n> --question urgentHelp --answer yes|no|unknown
  agent resume <session-id>
  agent sessions list
  agent sessions show <session-id>

当前真实可用：
  agent 安全会话基础和 record 全部命令

临床边界：
  当前无获批临床规则和方案，Agent 不输出证型、穴位、疗程或调理方案。

身份：
  通过 KANGMIN_SESSION_TOKEN 传递不透明会话令牌。
  CLI 不接受 patient_id/user_id。

机器输出：
  添加 --json 后 stdout 只输出一个 JSON 对象。
`;

/** 值为布尔标志、不需要取值的选项。 */
const FLAG_OPTIONS = new Set(["--yes"]);

/** 允许重复出现、收集为数组的选项。 */
const REPEATABLE_OPTIONS = new Set(["--factor"]);

const NUMBER_OPTIONS = new Set([
  "nasalCongestion",
  "nasalItching",
  "sneezing",
  "runnyNose",
  "expectedRevision"
]);

const OPTION_NAMES: Record<string, string> = {
  "--local-date": "localDate",
  "--date": "localDate",
  "--nasal-congestion": "nasalCongestion",
  "--nasal-itching": "nasalItching",
  "--sneezing": "sneezing",
  "--runny-nose": "runnyNose",
  "--notes": "notes",
  "--idempotency-key": "idempotencyKey",
  "--expected-revision": "expectedRevision",
  "--expected-version": "expectedRevision",
  "--display-name": "displayName",
  "--birth-date": "birthDate",
  "--sex": "sex",
  "--allergy-history": "allergyHistory",
  "--known-allergies": "knownAllergies",
  "--common-triggers": "commonTriggers",
  "--factor": "factors",
  "--other-description": "otherDescription",
  "--name": "medicationName",
  "--dosage": "dosage",
  "--actual-use": "actualUse",
  "--question": "question",
  "--answer": "answer",
  "--month": "month",
  "--from": "from",
  "--to": "to",
  "--yes": "yes"
};

interface ParsedCommand {
  command: string;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
}

function parseOptions(
  input: Record<string, unknown>,
  optionTokens: string[]
): void {
  for (let index = 0; index < optionTokens.length; ) {
    const token = optionTokens[index];
    if (token === undefined) {
      break;
    }
    const key = OPTION_NAMES[token];

    if (FLAG_OPTIONS.has(token)) {
      if (key !== undefined) {
        input[key] = true;
      }
      index += 1;
      continue;
    }

    const value = optionTokens[index + 1];
    if (key === undefined || value === undefined) {
      input.__parseError = `无效或缺少值的参数：${token}`;
      break;
    }
    if (value.startsWith("--")) {
      input.__parseError = `${token} 的值不能以 -- 开头：${value}`;
      break;
    }

    if (REPEATABLE_OPTIONS.has(token)) {
      const collected = (input[key] as string[] | undefined) ?? [];
      collected.push(value);
      input[key] = collected;
    } else {
      input[key] = NUMBER_OPTIONS.has(key) ? Number(value) : value;
    }
    index += 2;
  }
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

  const [group, resource, maybeAction, positional, ...rest] = filtered;
  if (group === "agent") {
    const input: Record<string, unknown> = {};
    if (resource === undefined || resource === "start") {
      const unexpected = resource === "start"
        ? [maybeAction, positional, ...rest].filter(
            (value): value is string => value !== undefined
          )
        : [];
      if (unexpected.length > 0) {
        input.__parseError = `agent start 不接受参数：${unexpected[0]}`;
      }
      return { command: resource === undefined ? "agent" : "agent start", input, json, help: false };
    }
    if (resource === "continue" || resource === "resume") {
      if (maybeAction === undefined || maybeAction.startsWith("--")) {
        input.__parseError = `agent ${resource} 需要会话 ID`;
      } else {
        input.id = maybeAction;
        parseOptions(input, [positional, ...rest].filter(
          (value): value is string => value !== undefined
        ));
      }
      return { command: `agent ${resource}`, input, json, help: false };
    }
    if (resource === "sessions" && maybeAction === "list") {
      if (positional !== undefined || rest.length > 0) {
        input.__parseError = `agent sessions list 不接受参数：${positional ?? rest[0]}`;
      }
      return { command: "agent sessions list", input, json, help: false };
    }
    if (resource === "sessions" && maybeAction === "show") {
      if (positional === undefined || positional.startsWith("--")) {
        input.__parseError = "agent sessions show 需要会话 ID";
      } else {
        input.id = positional;
      }
      return { command: "agent sessions show", input, json, help: false };
    }
    return { command: filtered.join(" "), input, json, help: false };
  }
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

  /** 只读投影命令是二级命令（record overview/calendar/trend），没有 action。 */
  const RESOURCE_ONLY = new Set(["overview", "calendar", "trend"]);
  const action = RESOURCE_ONLY.has(resource ?? "") ? undefined : maybeAction;

  const command = [group, resource, action].filter(Boolean).join(" ");
  const input: Record<string, unknown> = {};
  let optionTokens: string[];

  if (RESOURCE_ONLY.has(resource ?? "")) {
    optionTokens = [maybeAction, positional, ...rest].filter(
      (value): value is string => value !== undefined
    );
  } else {
    const profileScoped = resource === "profile" && action !== "delete";
    if (
      (action === "show" || action === "update" || action === "delete") &&
      !profileScoped
    ) {
      if (positional === undefined || positional.startsWith("--")) {
        input.__parseError = `${resource} ${action} 需要记录 ID`;
        optionTokens = [];
      } else {
        input.id = positional;
        optionTokens = rest;
      }
    } else {
      optionTokens = [positional, ...rest].filter(
        (value): value is string => value !== undefined
      );
    }
  }

  parseOptions(input, optionTokens);

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
