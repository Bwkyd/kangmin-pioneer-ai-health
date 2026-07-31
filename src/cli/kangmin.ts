#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
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

browse 命令：
  browse
  browse article list|categories
  browse article search <query>
  browse article show <id>
  browse video list|categories
  browse video search <query>
  browse video show <id>

agent 命令：
  agent start
  agent continue <session-id> --expected-revision <n> --question urgentHelp --answer yes|no|unknown
  agent resume <session-id>
  agent sessions list
  agent sessions show <session-id>

当前真实可用：
  agent 安全会话基础、record 全部命令、browse 已发布文章/视频

临床边界：
  当前无获批临床规则和方案，Agent 不输出证型、穴位、疗程或调理方案。

身份：
  通过 KANGMIN_SESSION_TOKEN 传递不透明会话令牌。
  CLI 不接受 patient_id/user_id。

机器输出：
  添加 --json 后 stdout 只输出一个 JSON 对象。
`;

/** 值为布尔标志、不需要取值的选项。 */
const FLAG_OPTIONS = new Set(["--yes", "--save-consent"]);

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
  "--yes": "yes",
  "--message": "message",
  "--conversation": "conversationId",
  "--save-consent": "saveConsent",
  "--rating": "rating",
  "--reason": "reason"
};

interface ParsedCommand {
  command: string;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
  /** 裸 kangmin 无参数且非 --json：启动交互式对话骨架。 */
  interactive?: boolean;
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
      const collected = (input[key] as unknown[] | undefined) ?? [];
      if (key === "answers") {
        const equals = value.indexOf("=");
        if (equals <= 0) {
          input.__parseError = `--answer 必须使用 fieldCode=state 格式：${value}`;
          break;
        }
        collected.push({
          fieldCode: value.slice(0, equals),
          state: value.slice(equals + 1)
        });
      } else {
        collected.push(value);
      }
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
    return {
      command: "agent exec",
      input: { message: "" },
      json,
      help: false,
      interactive: true
    };
  }

  const [group, resource, maybeAction, positional, ...rest] = filtered;
  if (group === "browse") {
    const input: Record<string, unknown> = {};
    if (resource === undefined) {
      return { command: "browse", input, json, help: false };
    }
    if (resource !== "article" && resource !== "video") {
      return { command: filtered.join(" "), input, json, help: false };
    }
    if (maybeAction === "list" || maybeAction === "categories") {
      if (positional !== undefined || rest.length > 0) {
        input.__parseError = `browse ${resource} ${maybeAction} 不接受额外参数`;
      }
      return {
        command: `browse ${resource} ${maybeAction}`,
        input,
        json,
        help: false
      };
    }
    if (maybeAction === "search" || maybeAction === "show") {
      if (positional === undefined || rest.length > 0) {
        input.__parseError = `browse ${resource} ${maybeAction} 需要且只接受一个${maybeAction === "search" ? "搜索词" : "内容 ID"}`;
      } else {
        input[maybeAction === "search" ? "query" : "id"] = positional;
      }
      return {
        command: `browse ${resource} ${maybeAction}`,
        input,
        json,
        help: false
      };
    }
    return { command: filtered.join(" "), input, json, help: false };
  }
  if (group === "agent") {
    const input: Record<string, unknown> = {};
    if (resource === undefined || resource === "start") {
      if (resource === "start") {
        parseOptions(input, [maybeAction, positional, ...rest].filter(
          (value): value is string => value !== undefined
        ));
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
    if (resource === "conversations" && (maybeAction === "list" || maybeAction === "show")) {
      if (maybeAction === "show") {
        if (positional === undefined || positional.startsWith("--")) {
          input.__parseError = "agent conversations show 需要对话 ID";
        } else {
          input.id = positional;
        }
      } else if (positional !== undefined || rest.length > 0) {
        input.__parseError = `agent conversations list 不接受参数：${positional ?? rest[0]}`;
      }
      return { command: "agent conversations " + maybeAction, input, json, help: false };
    }
    if (resource === "exec") {
      const tokens = [maybeAction, positional, ...rest].filter(
        (value): value is string => value !== undefined
      );
      // 选项与其值配对；其余 token 组成消息正文。
      const messageTokens: string[] = [];
      const optionTokens: string[] = [];
      for (let index = 0; index < tokens.length; ) {
        const token = tokens[index];
        if (token !== undefined && token.startsWith("--")) {
          optionTokens.push(token);
          const next = tokens[index + 1];
          if (next !== undefined && !next.startsWith("--")) {
            optionTokens.push(next);
            index += 2;
          } else {
            index += 1;
          }
        } else {
          messageTokens.push(token ?? "");
          index += 1;
        }
      }
      input.message = messageTokens.join(" ");
      parseOptions(input, optionTokens);
      return { command: "agent exec", input, json, help: false };
    }
    if (resource === "feedback") {
      if (maybeAction === undefined || maybeAction.startsWith("--")) {
        input.__parseError = "agent feedback 需要对话 ID";
      } else {
        input.conversationId = maybeAction;
        parseOptions(input, [positional, ...rest].filter(
          (value): value is string => value !== undefined
        ));
      }
      return { command: "agent feedback", input, json, help: false };
    }
    if (resource === "test" && maybeAction === "run") {
      const tokens = [positional, ...rest].filter(
        (value): value is string => value !== undefined
      );
      const answers: unknown[] = [];
      for (let index = 0; index < tokens.length; ) {
        const token = tokens[index];
        if (token !== "--answer") {
          input.__parseError = `agent test run 不接受参数：${token}`;
          break;
        }
        const value = tokens[index + 1];
        if (value === undefined || value.startsWith("--")) {
          input.__parseError = "--answer 需要 fieldCode=state 值";
          break;
        }
        const equals = value.indexOf("=");
        if (equals <= 0) {
          input.__parseError = `--answer 必须使用 fieldCode=state 格式：${value}`;
          break;
        }
        answers.push({
          fieldCode: value.slice(0, equals),
          state: value.slice(equals + 1)
        });
        index += 2;
      }
      if (answers.length > 0) {
        input.answers = answers;
      }
      return { command: "agent test run", input, json, help: false };
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
    // kangmin "我最近鼻塞" ≡ agent start --message "我最近鼻塞"
    const FIRST = new Set(["agent", "record", "browse", "account", "help", "doctor", "completion"]);
    if (!FIRST.has(group ?? "") && !(group ?? "").startsWith("-")) {
      return {
        command: "agent start",
        input: { message: group ?? "" },
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
  const data = result.data as Record<string, unknown> | null;
  if (
    data !== null &&
    typeof data === "object" &&
    typeof data.conversationId === "string" &&
    "message" in data
  ) {
    // agent exec / start --message 的人类可读输出：只显示助手正文与补问。
    const lines: string[] = [];
    const message = data.message as { content?: unknown } | null;
    if (message !== null && typeof message.content === "string") {
      lines.push(message.content);
    }
    const verdict = data.verdict as { nextQuestions?: unknown } | null;
    if (
      verdict !== null &&
      Array.isArray(verdict.nextQuestions) &&
      verdict.nextQuestions.length > 0
    ) {
      for (const question of verdict.nextQuestions as Array<{ prompt?: unknown }>) {
        if (typeof question.prompt === "string") {
          lines.push(`? ${question.prompt}`);
        }
      }
    }
    if (data.saveConfirmationRequired === true) {
      lines.push("（当前为匿名一次性体验。登录后再次确认保存，本次对话才会绑定到您的账号。）");
    }
    return lines.join("\n");
  }
  return JSON.stringify(result.data, null, 2);
}

/** 交互式对话骨架：裸 kangmin 进入，逐行一问一答。 */
async function runInteractive(
  application: ReturnType<typeof createApplication>,
  environment: NodeJS.ProcessEnv
): Promise<number> {
  const output = process.stdout;
  output.write("抗敏先锋鼻健康助手（体验版）\n");
  output.write("本工具仅提供体质调理参考，不构成医疗诊断；紧急情况请立即就医。\n");
  output.write("输入“退出”结束对话。\n");

  const readline = createInterface({
    input: process.stdin,
    output,
    terminal: true
  });

  let conversationId: string | undefined;
  try {
    for (;;) {
      const line = await readline.question("你 > ");
      const trimmed = line.trim();
      if (trimmed === "" ) {
        continue;
      }
      if (trimmed === "退出" || trimmed === "exit" || trimmed === "quit") {
        break;
      }
      const result = await application.execute({
        command: "agent exec",
        input: { message: trimmed, conversationId },
        sessionToken: environment.KANGMIN_SESSION_TOKEN
      });
      if (!result.ok) {
        output.write(`${result.error.code}: ${result.error.message}\n`);
        if (result.error.code === "authentication_required") {
          output.write("请通过 KANGMIN_SESSION_TOKEN 登录后重试。\n");
        }
        break;
      }
      const data = result.data as {
        conversationId: string;
        message: { content: string } | null;
        saveConfirmationRequired?: boolean;
        closed: boolean;
      };
      conversationId = data.conversationId;
      if (data.message !== null) {
        output.write(`助手 > ${data.message.content}\n`);
      }
      if (data.saveConfirmationRequired === true) {
        const answer = await readline.question("是否保存本次对话并绑定到您的账号？(y/n) > ");
        if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
          await application.execute({
            command: "agent exec",
            input: { message: "", conversationId, saveConsent: true },
            sessionToken: environment.KANGMIN_SESSION_TOKEN
          });
          output.write("本次对话已保存并绑定。\n");
        }
      }
      if (data.closed) {
        output.write("本次对话已结束，祝您健康。\n");
        break;
      }
    }
  } finally {
    readline.close();
  }
  return 0;
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

  // 裸 kangmin（TTY 交互终端）：启动对话骨架；非 TTY 回退单轮结构化结果。
  if (parsed.interactive === true && !parsed.json && process.stdin.isTTY === true) {
    const databasePath = resolve(
      environment.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
    );
    const interactiveApp = createApplication(databasePath);
    try {
      return await runInteractive(interactiveApp, environment);
    } finally {
      interactiveApp.close();
    }
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
