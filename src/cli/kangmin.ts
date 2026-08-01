#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { createInterface as createPasswordInterface } from "node:readline";

import { createApplication, runPatientDoctor } from "../app/composition-root.js";
import { DomainError, exitCodeForCode } from "../kernel/errors.js";
import { failure, success, type CommandResult } from "../kernel/result.js";

/** 与 package.json version 保持同步（主线程集成时统一）。 */
const VERSION = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
})();

const HELP = `抗敏先锋患者 CLI（Agent + Record + Browse + Account MVP）

用法：
  kangmin                         启动交互式对话（体验版，匿名可用）
  kangmin agent                   确定性安全会话（结构化问答，需登录）
  kangmin record                  管理自己的健康记录
  kangmin browse                  浏览环境与已发布内容
  kangmin account                 管理账号、授权和设置

辅助命令：
  kangmin --version               显示版本
  kangmin doctor                  检查数据库、存储和密钥配置状态
  kangmin completion zsh          生成 zsh 补全脚本

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
  browse article list [--limit N] [--offset N]
  browse article categories
  browse article search <query>
  browse article show <id>
  browse video list [--limit N] [--offset N]
  browse video categories
  browse video search <query>
  browse video show <id>
  browse plan list（临床规则包冻结后开放，当前返回空）
  browse plan show <id>（临床规则包冻结后开放，当前不可见）
  browse search <query>
  browse environment current [--city X]
  browse environment forecast [--days N]
  browse environment refresh [--city X]

browse 列表分页（article list / video list）：默认 limit 20、上限 100，
超出上限被截断而非报错；结果含 limit/offset 字段，便于翻页。

agent 命令（两条管线，路由按输入区分）：
  agent start                      确定性安全会话（结构化问答，需登录）
  agent start --message <文本>     自由对话管线（匿名可用，登录后确认可保存）
  agent exec <文本> [--conversation <id>] [--save-consent]
                                   非交互自由对话（--json 机器集成）
  agent conversations list         自由对话会话列表
  agent conversations show <id>    自由对话会话详情
  agent continue <session-id> --expected-revision <n> --question urgentHelp --answer yes|no|unknown
  agent resume <session-id>        恢复确定性安全会话
  agent sessions list|show         确定性安全会话列表/详情
  agent feedback <id> --rating helpful|unhelpful [--reason <文本>]

模拟测试（agent test run）属于管理端：kangmin-admin agent test run。

account 命令：
  account register --username <用户名> [--nickname <昵称>]
  account login --username <用户名>
  account status
  account logout
  account profile show
  account profile update [--nickname <昵称>]
  account consent show
  account consent update --type privacy|medical_boundary
      --decision granted|withdrawn --policy-version <版本> --request-id <ID>
  account privacy
  account data export|deletion-request|request-status|deactivate
      （本版本明确未实现）
  account reminder|notification
      （本版本明确未实现）

密码输入：
  register/login 的密码从 stdin 读取：交互终端隐藏回显；
  非交互环境通过管道/重定向提供，未提供时命令明确失败且不阻塞等待。
  密码不会出现在命令行参数、历史或日志中。

当前真实可用：
  agent 确定性安全会话 + 自由对话管线（临床规则包为 candidate，正式输出阻断）、
  record 全部命令、browse 已发布文章/视频/环境快照（方案待临床冻结后开放）、
  account 注册/登录/状态/退出/资料/同意/隐私。

临床边界：
  当前无获批临床规则和方案，Agent 不输出证型、穴位、疗程或调理方案。

身份：
  通过 KANGMIN_SESSION_TOKEN 传递不透明会话令牌。
  CLI 不接受 patient_id/user_id。

机器输出：
  添加 --json 后 stdout 只输出一个 JSON 对象。
`;

const ZSH_COMPLETION = `#compdef kangmin
# 抗敏先锋患者 CLI 补全（静态生成）
_kangmin() {
  local -a groups
  groups=(
    'agent:确定性安全会话与自由对话'
    'record:管理自己的健康记录'
    'browse:浏览环境与已发布内容'
    'account:管理账号、授权和设置'
    'help:显示帮助'
    'doctor:检查服务状态'
    'completion:生成 zsh 补全脚本'
  )
  if (( CURRENT == 2 )); then
    _describe '命令组' groups
    return
  fi
  local group="\${words[2]}"
  local -a sub
  case "\$group" in
    agent) sub=('start:开始会话' 'exec:非交互对话' 'continue:继续安全会话' 'resume:恢复安全会话' 'sessions:安全会话列表/详情' 'conversations:自由对话列表/详情' 'feedback:对话反馈') ;;
    record) sub=('symptom:症状/TNSS 记录' 'profile:健康档案' 'exposure:暴露记录' 'medication:用药记录' 'overview:健康概览' 'calendar:日历' 'trend:趋势') ;;
    browse) sub=('article:科普文章' 'video:视频内容' 'plan:通用方案' 'search:跨内容搜索' 'environment:环境快照') ;;
    account) sub=('register:注册' 'login:登录' 'status:登录状态' 'logout:退出' 'profile:资料' 'consent:同意管理' 'privacy:隐私政策') ;;
  esac
  if (( CURRENT == 3 )); then
    _describe '子命令' sub
  fi
}
_kangmin "\$@"
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
  "expectedRevision",
  "limit",
  "offset",
  "days"
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
  "--limit": "limit",
  "--offset": "offset",
  "--city": "city",
  "--days": "days",
  "--message": "message",
  "--conversation": "conversationId",
  "--save-consent": "saveConsent",
  "--rating": "rating",
  "--reason": "reason",
  "--yes": "yes",
  "--username": "username",
  "--nickname": "nickname",
  "--type": "consentType",
  "--consent-type": "consentType",
  "--decision": "decision",
  "--policy-version": "policyVersion",
  "--request-id": "requestId"
};

/** account 组中带 action 的资源（第三词是动作而非选项）。 */
const ACCOUNT_RESOURCES_WITH_ACTION = new Set([
  "profile",
  "consent",
  "data",
  "reminder",
  "notification"
]);

/** account 组中第一个位置参数是记录 ID 的命令。 */
const ACCOUNT_ID_COMMANDS = new Set([
  "account notification read",
  "account data request-status"
]);

/** 密码从 stdin 读取的命令（密码绝不进入 argv）。 */
const PASSWORD_COMMANDS = new Set(["account register", "account login"]);

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

function parseAccount(filtered: string[], json: boolean): ParsedCommand {
  const [, resource, maybeAction, positional, ...rest] = filtered;
  if (resource === undefined) {
    return { command: "account", input: {}, json, help: false };
  }

  const withAction = ACCOUNT_RESOURCES_WITH_ACTION.has(resource);
  const command = withAction
    ? `account ${resource} ${maybeAction ?? ""}`.trim()
    : `account ${resource}`;
  const optionTokens = withAction
    ? [positional, ...rest]
    : [maybeAction, positional, ...rest];

  const input: Record<string, unknown> = {};
  if (
    ACCOUNT_ID_COMMANDS.has(command) &&
    optionTokens[0] !== undefined &&
    optionTokens[0] !== "" &&
    !optionTokens[0].startsWith("--")
  ) {
    input.id = optionTokens[0];
    optionTokens.shift();
  }
  parseOptions(
    input,
    optionTokens.filter((value): value is string => value !== undefined)
  );
  return { command, input, json, help: false };
}

/** 收集首个 -- 之前的裸词为查询词，之后的 token 全部视为选项。 */
function collectBareQuery(
  tokens: string[]
): { query: string; optionTokens: string[] } {
  const queryParts: string[] = [];
  const optionTokens: string[] = [];
  let seenOption = false;
  for (const token of tokens) {
    if (token.startsWith("--")) {
      seenOption = true;
      optionTokens.push(token);
    } else if (seenOption) {
      optionTokens.push(token);
    } else {
      queryParts.push(token);
    }
  }
  return { query: queryParts.join(" "), optionTokens };
}

function parseBrowse(
  filtered: string[],
  resource: string | undefined,
  maybeAction: string | undefined,
  positional: string | undefined,
  rest: string[],
  json: boolean
): ParsedCommand {
  const input: Record<string, unknown> = {};
  if (resource === undefined) {
    return { command: "browse", input, json, help: false };
  }

  // browse search <query>：跨文章/视频/通用方案。
  if (resource === "search") {
    const { query, optionTokens } = collectBareQuery(
      [maybeAction, positional, ...rest].filter(
        (value): value is string => value !== undefined
      )
    );
    if (query === "") {
      input.__parseError = "browse search 需要搜索词";
    } else {
      input.query = query;
    }
    parseOptions(input, optionTokens);
    return { command: "browse search", input, json, help: false };
  }

  // browse environment current|forecast|refresh。
  if (resource === "environment") {
    if (maybeAction === "current" || maybeAction === "refresh" || maybeAction === "forecast") {
      const optionTokens = [positional, ...rest].filter(
        (value): value is string => value !== undefined
      );
      // 位置参数直接跟在 action 后（如 `current 上海`）不是合法用法；
      // 选项值（--city 成都）属于 rest，不受此检查影响。
      if (positional !== undefined && !positional.startsWith("--")) {
        input.__parseError = `browse environment ${maybeAction} 只接受选项参数（--city/--days）`;
      } else {
        parseOptions(input, optionTokens);
      }
      return {
        command: `browse environment ${maybeAction}`,
        input,
        json,
        help: false
      };
    }
    return { command: filtered.join(" "), input, json, help: false };
  }

  // browse plan list|show。
  if (resource === "plan") {
    if (maybeAction === "list") {
      if (positional !== undefined || rest.length > 0) {
        input.__parseError = "browse plan list 不接受额外参数";
      }
      return { command: "browse plan list", input, json, help: false };
    }
    if (maybeAction === "show") {
      if (positional === undefined || positional.startsWith("--") || rest.length > 0) {
        input.__parseError = "browse plan show 需要且只接受一个方案 ID";
      } else {
        input.id = positional;
      }
      return { command: "browse plan show", input, json, help: false };
    }
    return { command: filtered.join(" "), input, json, help: false };
  }

  if (resource !== "article" && resource !== "video") {
    return { command: filtered.join(" "), input, json, help: false };
  }
  if (maybeAction === "list") {
    parseOptions(
      input,
      [positional, ...rest].filter(
        (value): value is string => value !== undefined
      )
    );
    return {
      command: `browse ${resource} list`,
      input,
      json,
      help: false
    };
  }
  if (maybeAction === "categories") {
    if (positional !== undefined || rest.length > 0) {
      input.__parseError = `browse ${resource} categories 不接受额外参数`;
    }
    return {
      command: `browse ${resource} categories`,
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

function parse(argv: string[]): ParsedCommand {
  const json = argv.includes("--json");
  const filtered = argv.filter((value) => value !== "--json");
  const help = filtered.includes("--help") || filtered.includes("-h");
  if (help) {
    return { command: "help", input: {}, json, help: true };
  }

  if (filtered[0] === "--version") {
    return { command: "__version__", input: {}, json, help: false };
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
  if (group === "account") {
    return parseAccount(filtered, json);
  }
  if (group === "browse") {
    return parseBrowse(filtered, resource, maybeAction, positional, rest, json);
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
    if (items.length === 0) {
      return result.command.startsWith("account ")
        ? "暂无同意记录"
        : "暂无症状记录";
    }
    return JSON.stringify(items, null, 2);
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

/**
 * 交互终端：隐藏回显的密码提示（输入以 * 回显，提示文本原样输出）。
 * 密码只经 stdin 进入进程内存，不落 argv、命令历史或日志。
 */
function readPasswordFromTty(): Promise<string> {
  const readline = createPasswordInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true
  });
  const output = (readline as unknown as { output: NodeJS.WritableStream })
    .output;
  let firstWrite = true;
  (
    readline as unknown as {
      _writeToOutput: (chunk: string) => void;
    }
  )._writeToOutput = (chunk: string) => {
    if (firstWrite) {
      output.write(chunk);
      firstWrite = false;
    } else {
      output.write("*");
    }
  };
  return new Promise<string>((resolve) => {
    readline.question("密码（输入不回显）：", (answer) => {
      output.write("\n");
      readline.close();
      resolve(answer);
    });
  });
}

/** 非交互：读取管道/重定向输入的第一行作为密码；无内容返回 undefined。 */
function readPasswordFromPipe(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const firstLine = data.split("\n")[0] ?? "";
      resolve(firstLine === "" ? undefined : firstLine);
    });
    process.stdin.on("error", () => {
      resolve(undefined);
    });
  });
}

async function readPassword(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return readPasswordFromTty();
  }
  return readPasswordFromPipe();
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

  const readline = createPromptInterface({
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
  // 裸 `help` 词：parse 层映射为 help 命令，免登录直接输出（外部评审 P1-10）。
  if (parsed.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  // 辅助命令：版本与补全不依赖应用实例，直接输出。
  if (parsed.command === "__version__") {
    process.stdout.write(`kangmin ${VERSION}\n`);
    return 0;
  }
  if (parsed.command === "completion") {
    const result = failure(
      "completion",
      new DomainError("command_invalid", "completion 只支持 zsh")
    );
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`command_invalid: completion 只支持 zsh\n`);
    }
    return 2;
  }
  if (parsed.command === "completion zsh") {
    process.stdout.write(ZSH_COMPLETION);
    return 0;
  }

  // doctor 不依赖应用实例：即使加密密钥缺失（createApplication 会抛
  // config_missing）也要输出结构化检查报告，而不是整体启动失败。
  if (parsed.command === "doctor") {
    const databasePath = resolve(
      environment.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
    );
    const report = runPatientDoctor(databasePath, environment);
    const result = success("doctor", report);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${human(result)}\n`);
    }
    return report.healthy ? 0 : 6;
  }

  // 裸 kangmin（TTY 交互终端）：启动对话骨架；非 TTY 回退单轮结构化结果。
  // createApplication 与主路径一致在 try/catch 内：生产缺密钥时以
  // config_missing 干净退出（exit 5），不打印堆栈（外部评审 P1-11）。
  if (parsed.interactive === true && !parsed.json && process.stdin.isTTY === true) {
    const databasePath = resolve(
      environment.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
    );
    let interactiveApp;
    try {
      interactiveApp = createApplication(databasePath);
    } catch (error) {
      const result = failure("system bootstrap", error);
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
      return exitCodeForCode(result.error.code);
    }
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

  // 密码只从 stdin 读，绝不接受命令行参数；非交互空 stdin 由应用层
  // 返回 confirmation_required/authentication_required，不阻塞等待。
  if (PASSWORD_COMMANDS.has(parsed.command)) {
    const password = await readPassword();
    if (password !== undefined) {
      parsed.input.password = password;
    }
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
    if (parsed.command === "account login" && result.ok) {
      const data = result.data as { token?: unknown };
      if (parsed.json) {
        // --json：token 保留在 data.token（机器集成读取后写入
        // KANGMIN_SESSION_TOKEN；README 已注明该字段语义）。
      } else if (typeof data.token === "string" && data.token !== "") {
        // human 模式（事务与卫生残留批 P2-12c）：令牌只写 stderr，
        // stdout 绝不出现令牌；stdout 给固定提示。
        process.stderr.write(
          `会话令牌（请写入环境变量 KANGMIN_SESSION_TOKEN）：${data.token}\n`
        );
        delete data.token;
      }
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      process.stdout.write(`${human(result)}\n`);
    } else {
      process.stderr.write(`${human(result)}\n`);
    }
    if (parsed.command === "doctor" && result.ok) {
      const report = result.data as { healthy: boolean };
      return report.healthy ? 0 : 6;
    }
    return result.ok ? 0 : exitCodeForCode(result.error.code);
  } finally {
    application.close();
  }
}

process.exitCode = await runCli(process.argv.slice(2));
