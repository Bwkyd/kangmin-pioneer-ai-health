#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { createAdminApplication } from "../app/admin-composition-root.js";
import {
  createRemoteCommandClient,
  remoteCommandBaseUrl,
  remoteTimeout
} from "../app/remote-command-composition-root.js";
import { DomainError, exitCodeForCode } from "../kernel/errors.js";
import { failure, type CommandResult } from "../kernel/result.js";
import {
  assertKnowledgeExtension,
  assertSizeWithinLimit,
  DEFAULT_MEDIA_MAX_BYTES
} from "../modules/admin/media-validation.js";

/** 与 package.json version 保持同步（主线程集成时统一）。 */
const VERSION = "0.1.0";

const HELP = `抗敏先锋管理后台 CLI

用法：
  kangmin-admin <命令组> <子命令> [选项]

命令组：
  content      管理文章、视频、素材和公告
  agent        管理知识库、调理方案、模型和模拟测试
  users        只读查看患者用户、会话和健康记录
  auth         登录并管理普通管理员账号

辅助命令：
  kangmin-admin help                显示本帮助
  kangmin-admin doctor              检查数据库、存储、账号和模型连接状态
  kangmin-admin --version           显示版本
  kangmin-admin completion zsh      生成 zsh 补全脚本

content 命令：
  article       list|show|create|update|preview|publish|unpublish
  video         list|show|create|update|preview|publish|unpublish
                create/update 使用 --category-id <稳定分类 ID>（可重复）
  media         list|show|upload <file>|disable|delete
                upload-init --filename <f> --size-bytes <n> --sha256 <hex> [--kind <k>]
                upload-confirm --media <id> --sha256 <hex>
                cleanup-orphans [--older-than <分钟>] --yes
  category      list|show|create|update|disable
  message       list|show|create|update|publish|unpublish

agent 命令：
  status
  knowledge     folder list|create|update|delete
                list|show|add <file>|add-from-media --media <id>|update|delete|index|enable|disable|search-test <query>|move
  plan          list|show|create|update|preview|enable|disable|mappings
  model         show|update|test（--api-key 为标志，密钥从 stdin 读取）
  test          run|case <case-id>

users 命令：
  list|show|sessions|records|activity

auth 命令：
  login --username <u>      密码从 stdin 读取（隐藏输入）
  status|whoami             当前登录状态与身份
  admins list|add|enable|disable
  logout                    撤销当前会话

身份：
  管理员令牌经 KANGMIN_ADMIN_TOKEN 环境变量传入（与患者 KANGMIN_SESSION_TOKEN 分离）。
  auth login 成功后令牌写入本地凭据文件（仅当前用户可读，0600）。
  凭据绑定签发环境（本地库或服务地址），不会跨环境复用。
  密码与模型 API Key 不进入命令行参数或历史：
  --api-key 是标志，密钥值从 stdin 读取（TTY 隐藏回显，管道读首行；
  空输入表示本次不修改密钥）。

机器输出：
  添加 --json 后 stdout 只输出一个 JSON 对象；进度与诊断进入 stderr。
  发布/下架/删除/停用/启用等高影响操作需要 --yes 显式确认。
`;

const ZSH_COMPLETION = `#compdef kangmin-admin
# 抗敏先锋管理后台 CLI 补全（静态生成）
_kangmin_admin() {
  local -a groups
  groups=(
    'content:管理文章、视频、素材和公告'
    'agent:管理知识库、调理方案、模型和模拟测试'
    'users:只读查看患者用户、会话和健康记录'
    'auth:登录并管理普通管理员账号'
    'help:显示帮助'
    'doctor:检查服务连接状态'
    'completion:生成 zsh 补全脚本'
  )
  if (( CURRENT == 2 )); then
    _describe '命令组' groups
    return
  fi
  local group="\${words[2]}"
  local -a sub
  case "\$group" in
    content) sub=('article:科普文章' 'video:视频内容' 'media:素材库' 'category:内容分类' 'message:站内公告') ;;
    agent) sub=('status:智能体状态' 'knowledge:知识库' 'plan:调理方案' 'model:模型设置' 'test:模拟测试') ;;
    users) sub=('list:用户列表' 'show:用户详情' 'sessions:会话' 'records:健康记录' 'activity:使用概览') ;;
    auth) sub=('login:登录' 'status:登录状态' 'whoami:当前身份' 'admins:管理员账号' 'logout:退出') ;;
  esac
  if (( CURRENT == 3 )); then
    _describe '子命令' sub
  fi
}
_kangmin_admin "\$@"
`;

/** 值为布尔标志、不需要取值的选项。 */
const FLAG_OPTIONS = new Set(["--yes", "--api-key"]);
/** 取值为 true/false 的选项。 */
const BOOLEAN_VALUE_OPTIONS = new Set(["--knowledge-retrieval", "--explanation-enabled"]);
/** 取值为数字的选项。 */
const NUMBER_OPTIONS = new Set([
  "displayOrder",
  "expectedRevision",
  "timeout",
  "maxOutput",
  "retrievalCount",
  "limit",
  "sizeBytes",
  "olderThanMinutes",
  "sortOrder"
]);
/** 允许重复出现、收集为数组的选项。 */
const REPEATABLE_OPTIONS = new Set(["--step", "--method-tag", "--category-id"]);

const OPTION_NAMES: Record<string, string> = {
  "--username": "username",
  "--role": "role",
  "--title": "title",
  "--category": "category",
  "--category-id": "categoryIds",
  "--summary": "summary",
  "--body": "body",
  "--source": "source",
  "--cover": "coverMediaId",
  "--media": "mediaId",
  "--instructions": "instructions",
  "--precautions": "precautions",
  "--disclaimer": "disclaimer",
  "--method-tag": "methodTags",
  "--display-order": "displayOrder",
  "--order": "displayOrder",
  "--expected-revision": "expectedRevision",
  "--status": "status",
  "--name": "name",
  "--description": "description",
  "--kind": "kind",
  "--provider": "provider",
  "--model-name": "modelName",
  "--timeout": "timeout",
  "--max-output": "maxOutput",
  "--retrieval-count": "retrievalCount",
  "--knowledge-retrieval": "knowledgeRetrieval",
  "--explanation-enabled": "explanationEnabled",
  "--api-key": "apiKeyRequested",
  "--query": "query",
  "--syndrome": "syndrome",
  "--method": "method",
  "--step": "steps",
  "--risks": "risks",
  "--contraindications": "contraindications",
  "--applicable-age": "applicableAge",
  "--video": "videoResourceId",
  "--active-within": "activeWithin",
  "--type": "type",
  "--limit": "limit",
  "--idempotency-key": "idempotencyKey",
  "--file": "file",
  "--filename": "filename",
  "--size-bytes": "sizeBytes",
  "--sha256": "sha256",
  "--older-than": "olderThanMinutes",
  "--folder-id": "folderId",
  "--parent-id": "parentId",
  "--sort-order": "sortOrder",
  "--yes": "yes"
};

type PositionalKind = "id" | "file" | "query" | null;

interface CommandSpec {
  positional: PositionalKind;
  required: boolean;
}

const COMMAND_SPECS: Record<string, CommandSpec> = {
  // ---- auth ----
  "auth login": { positional: null, required: false },
  "auth status": { positional: null, required: false },
  "auth whoami": { positional: null, required: false },
  "auth logout": { positional: null, required: false },
  "auth admins list": { positional: null, required: false },
  "auth admins add": { positional: null, required: false },
  "auth admins enable": { positional: "id", required: true },
  "auth admins disable": { positional: "id", required: true },

  // ---- content article / video / message ----
  "content article list": { positional: null, required: false },
  "content article create": { positional: null, required: false },
  "content article show": { positional: "id", required: true },
  "content article update": { positional: "id", required: true },
  "content article preview": { positional: "id", required: true },
  "content article publish": { positional: "id", required: true },
  "content article unpublish": { positional: "id", required: true },
  "content video list": { positional: null, required: false },
  "content video create": { positional: null, required: false },
  "content video show": { positional: "id", required: true },
  "content video update": { positional: "id", required: true },
  "content video preview": { positional: "id", required: true },
  "content video publish": { positional: "id", required: true },
  "content video unpublish": { positional: "id", required: true },
  "content message list": { positional: null, required: false },
  "content message create": { positional: null, required: false },
  "content message show": { positional: "id", required: true },
  "content message update": { positional: "id", required: true },
  "content message publish": { positional: "id", required: true },
  "content message unpublish": { positional: "id", required: true },

  // ---- content media ----
  "content media list": { positional: null, required: false },
  "content media upload": { positional: "file", required: true },
  "content media upload-init": { positional: null, required: false },
  "content media upload-confirm": { positional: null, required: false },
  "content media cleanup-orphans": { positional: null, required: false },
  "content media show": { positional: "id", required: true },
  "content media disable": { positional: "id", required: true },
  "content media delete": { positional: "id", required: true },

  // ---- content category ----
  "content category list": { positional: null, required: false },
  "content category create": { positional: null, required: false },
  "content category show": { positional: "id", required: true },
  "content category update": { positional: "id", required: true },
  "content category disable": { positional: "id", required: true },

  // ---- agent ----
  "agent status": { positional: null, required: false },
  "agent knowledge folder list": { positional: null, required: false },
  "agent knowledge folder create": { positional: null, required: false },
  "agent knowledge folder update": { positional: "id", required: true },
  "agent knowledge folder delete": { positional: "id", required: true },
  "agent knowledge list": { positional: null, required: false },
  "agent knowledge show": { positional: "id", required: true },
  "agent knowledge add": { positional: "file", required: true },
  "agent knowledge add-from-media": { positional: null, required: false },
  "agent knowledge update": { positional: "id", required: true },
  "agent knowledge delete": { positional: "id", required: true },
  "agent knowledge index": { positional: "id", required: true },
  "agent knowledge enable": { positional: "id", required: true },
  "agent knowledge disable": { positional: "id", required: true },
  "agent knowledge search-test": { positional: "query", required: true },
  "agent knowledge move": { positional: "id", required: true },
  "agent plan list": { positional: null, required: false },
  "agent plan create": { positional: null, required: false },
  "agent plan show": { positional: "id", required: true },
  "agent plan update": { positional: "id", required: true },
  "agent plan preview": { positional: "id", required: true },
  "agent plan enable": { positional: "id", required: true },
  "agent plan disable": { positional: "id", required: true },
  "agent plan mappings": { positional: null, required: false },
  "agent model show": { positional: null, required: false },
  "agent model update": { positional: null, required: false },
  "agent model test": { positional: null, required: false },
  "agent test run": { positional: null, required: false },
  "agent test case": { positional: "id", required: true },

  // ---- users ----
  "users list": { positional: null, required: false },
  "users show": { positional: "id", required: true },
  "users sessions": { positional: "id", required: true },
  "users records": { positional: "id", required: true },
  "users activity": { positional: null, required: false }
};

const GROUP_HINTS: Record<string, string> = {
  auth: "auth 需要子命令：login | status | whoami | logout | admins list|add|enable|disable",
  content: "content 需要资源：article | video | media | category | message",
  agent: "agent 需要资源：status | knowledge | plan | model | test",
  users: "users 需要子命令：list | show | sessions | records | activity"
};

interface Parsed {
  kind: "help" | "version" | "completion" | "command" | "parse-error";
  command: string;
  input: Record<string, unknown>;
  json: boolean;
  message?: string;
}

function parse(argv: string[]): Parsed {
  const json = argv.includes("--json");
  const tokens = argv.filter((value) => value !== "--json");

  if (tokens.length === 0) {
    return { kind: "help", command: "", input: {}, json };
  }
  if (tokens[0] === "--version" || tokens[0] === "version") {
    return { kind: "version", command: "", input: {}, json };
  }
  if (
    tokens[0] === "help" ||
    tokens.includes("--help") ||
    tokens.includes("-h")
  ) {
    return { kind: "help", command: "", input: {}, json };
  }
  if (tokens[0] === "completion") {
    if (tokens[1] !== "zsh") {
      return {
        kind: "parse-error",
        command: "completion",
        input: {},
        json,
        message: "completion 只支持 zsh"
      };
    }
    return { kind: "completion", command: "", input: {}, json };
  }
  if (tokens[0] === "doctor") {
    return { kind: "command", command: "doctor", input: {}, json };
  }

  const [group, resource, action, ...rest] = tokens;
  let command: string;
  let optionTokens: string[];
  const matchedCommand = Object.keys(COMMAND_SPECS)
    .map((candidate) => ({ candidate, words: candidate.split(" ") }))
    .sort((left, right) => right.words.length - left.words.length)
    .find(({ words }) => words.every((word, index) => tokens[index] === word));

  if (matchedCommand !== undefined) {
    command = matchedCommand.candidate;
    optionTokens = tokens.slice(matchedCommand.words.length);
  } else if (group === "auth") {
    if (resource === undefined) {
      return parseError("auth", GROUP_HINTS.auth ?? "auth 需要子命令", json);
    }
    if (resource === "admins") {
      if (action === undefined) {
        return parseError("auth admins", "auth admins 需要 list | add | enable | disable", json);
      }
      command = `auth admins ${action}`;
      optionTokens = rest;
    } else {
      command = `auth ${resource}`;
      optionTokens = [action, ...rest].filter((value): value is string => value !== undefined);
    }
  } else if (group === "content" || group === "agent") {
    if (resource === undefined) {
      return parseError(group ?? "", GROUP_HINTS[group ?? ""] ?? "未知命令组", json);
    }
    if (group === "agent" && resource === "status") {
      command = "agent status";
      optionTokens = [action, ...rest].filter((value): value is string => value !== undefined);
    } else {
      if (action === undefined) {
        return parseError(`${group} ${resource}`, `命令不完整：${group} ${resource} 需要子命令`, json);
      }
      command = `${group} ${resource} ${action}`;
      optionTokens = rest;
    }
  } else if (group === "users") {
    if (resource === undefined) {
      return parseError("users", GROUP_HINTS.users ?? "users 需要子命令", json);
    }
    command = `users ${resource}`;
    optionTokens = [action, ...rest].filter((value): value is string => value !== undefined);
  } else {
    return parseError(group ?? "", `未知命令组：${group ?? "(empty)"}`, json);
  }

  const spec = COMMAND_SPECS[command];
  if (spec === undefined) {
    return parseError(command, `未知命令：${command}`, json);
  }

  const input: Record<string, unknown> = {};
  if (spec.positional !== null) {
    const first = optionTokens[0];
    if (spec.positional === "query" && first !== undefined && !first.startsWith("--")) {
      input.query = optionTokens.filter((value) => !value.startsWith("--")).join(" ");
      optionTokens = optionTokens.filter((value) => value.startsWith("--"));
    } else if (first !== undefined && !first.startsWith("--")) {
      input[spec.positional] = first;
      optionTokens = optionTokens.slice(1);
    } else if (spec.required) {
      return parseError(command, `${command} 需要 ${spec.positional}`, json);
    }
  } else {
    const first = optionTokens[0];
    if (first !== undefined && !first.startsWith("--")) {
      return parseError(command, `${command} 不接受位置参数：${first}`, json);
    }
  }

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
      return parseError(command, `无效或缺少值的参数：${token}`, json);
    }
    if (value.startsWith("--")) {
      return parseError(command, `${token} 的值不能以 -- 开头：${value}`, json);
    }

    if (BOOLEAN_VALUE_OPTIONS.has(token)) {
      if (value !== "true" && value !== "false") {
        return parseError(command, `${token} 的值必须是 true 或 false`, json);
      }
      input[key] = value === "true";
    } else if (REPEATABLE_OPTIONS.has(token)) {
      const collected = (input[key] as string[] | undefined) ?? [];
      collected.push(value);
      input[key] = collected;
    } else {
      input[key] = NUMBER_OPTIONS.has(key) ? Number(value) : value;
    }
    index += 2;
  }

  return { kind: "command", command, input, json };
}

function parseError(
  command: string,
  message: string,
  json: boolean
): Parsed {
  return { kind: "parse-error", command, input: {}, json, message };
}

// ---- 本地凭据（系统安全凭据存储的本地形态，仅当前用户可读） ----

interface Credentials {
  token: string;
  username: string;
  expiresAt: string;
  /**
   * 签发该令牌的服务地址（远程模式）；本地模式为空。
   * 令牌只在其签发环境下使用，避免把本地或 A 环境的令牌发给 B 服务。
   */
  baseUrl?: string | undefined;
}

interface AdminCommandExecutor {
  execute(input: {
    command: string;
    input?: Record<string, unknown> | undefined;
    requestId?: string | undefined;
  }): Promise<CommandResult>;
  close(): void;
}

function createAdminExecutor(
  environment: NodeJS.ProcessEnv,
  databasePath: string,
  mediaDirectory: string,
  token: string | undefined
): AdminCommandExecutor {
  const baseUrl = remoteCommandBaseUrl(environment);
  if (baseUrl !== undefined) {
    const client = createRemoteCommandClient(environment, "admin", token);
    return {
      execute: (input) => client.execute(input),
      close: () => {}
    };
  }
  if (
    environment.KANGMIN_APP_ENV === "staging" ||
    environment.KANGMIN_APP_ENV === "production"
  ) {
    throw new DomainError(
      "config_missing",
      "staging/production CLI 必须配置 KANGMIN_API_BASE_URL，禁止回退本地数据库"
    );
  }
  const application = createAdminApplication(databasePath, { mediaDirectory });
  return {
    execute: (input) => application.execute({
      ...input,
      adminToken: token
    }),
    close: () => application.close()
  };
}

function credentialsPath(databasePath: string): string {
  return join(dirname(databasePath), ".kangmin-admin.credentials.json");
}

function readCredentials(databasePath: string): Credentials | null {
  try {
    const parsed = JSON.parse(
      readFileSync(credentialsPath(databasePath), "utf8")
    ) as Partial<Credentials>;
    if (
      typeof parsed.token === "string" &&
      parsed.token !== "" &&
      typeof parsed.username === "string" &&
      typeof parsed.expiresAt === "string"
    ) {
      return {
        token: parsed.token,
        username: parsed.username,
        expiresAt: parsed.expiresAt,
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl !== ""
          ? parsed.baseUrl
          : undefined
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCredentials(databasePath: string, credentials: Credentials): void {
  const path = credentialsPath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  // 评审 P2：writeFileSync 的 mode 只在新建时生效，已存在的凭据文件
  // 不会被收权——无论新建还是已存在，写入后一律 chmod 0600，
  // 保证"仅当前用户可读"（凭据含管理员令牌）。
  chmodSync(path, 0o600);
}

function clearCredentials(databasePath: string): void {
  try {
    rmSync(credentialsPath(databasePath), { force: true });
  } catch {
    // 忽略：凭据文件不存在时无需处理。
  }
}

// ---- 敏感输入读取（密码/API Key；隐藏回显；非 TTY 管道读到 EOF 取首行） ----

/**
 * 从 stdin 读取敏感输入（密码、API Key）。
 * - TTY：隐藏回显，提示与回显符只写 stderr（--json 时 stdout 不被污染）；
 * - 非 TTY：管道/重定向读到 EOF 取第一行；无内容返回 undefined，
 *   调用方据此明确失败或跳过，绝不悬挂等待（exit 13 修复）。
 */
function readSecret(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (stdin.isTTY === true) {
    stdin.setRawMode(true);
    process.stderr.write(prompt);
    return new Promise<string>((resolve) => {
      let value = "";
      const finish = (result: string): void => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(result);
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 3) {
            finish("");
            return;
          }
          if (byte === 13 || byte === 10) {
            finish(value);
            return;
          }
          if (byte === 127 || byte === 8) {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stderr.write("\b \b");
            }
            continue;
          }
          value += String.fromCharCode(byte);
          process.stderr.write("*");
        }
      };
      stdin.on("data", onData);
      stdin.resume();
    });
  }
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", () => {
      const firstLine = data.split("\n")[0] ?? "";
      resolve(firstLine === "" ? undefined : firstLine);
    });
    stdin.on("error", () => {
      resolve(undefined);
    });
  });
}

// ---- 远程上传编排（仅远程模式：init → 预签名直传 → confirm） ----

/**
 * 远程模式下 `content media upload <file>` 与 `agent knowledge add <file>`
 * 在 CLI 本地编排三步（命令契约不变，体感与本地一致）：
 * 1. content media upload-init 申请预签名直传票据（重复上传直接重放）；
 * 2. HTTP PUT 直传对象存储（不经过命令服务，服务端不接收客户端路径）；
 * 3. content media upload-confirm 校验和确认（服务端完成魔数双校验）。
 * agent knowledge add 在 confirm 就绪后追加 add-from-media 建知识。
 * 本地模式不经过此路径，行为一字不改。
 */
interface RemoteUploadTicketView {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface RemoteUploadInitData {
  status: "completed" | "uploading";
  media?: { id: string } | undefined;
  mediaId?: string | undefined;
  ticket?: RemoteUploadTicketView | undefined;
}

const DEFAULT_PUT_TIMEOUT_MS = 15_000;

async function orchestrateRemoteUpload(
  executor: AdminCommandExecutor,
  command: "content media upload" | "agent knowledge add",
  input: Record<string, unknown>,
  environment: NodeJS.ProcessEnv
): Promise<CommandResult> {
  const file = input.file as string;
  let sizeBytes: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      return failure(
        command,
        new DomainError("validation_failed", "素材路径必须是文件")
      );
    }
    sizeBytes = stats.size;
  } catch (error) {
    if (error instanceof DomainError) {
      return failure(command, error);
    }
    return failure(
      command,
      new DomainError("validation_failed", "素材文件不存在或不可读", {
        cause: error
      })
    );
  }
  try {
    // 大小与知识扩展名预检：与服务端 init/add-from-media 同规则，快速失败。
    assertSizeWithinLimit(sizeBytes, DEFAULT_MEDIA_MAX_BYTES, "素材文件");
    if (command === "agent knowledge add") {
      assertKnowledgeExtension(file);
    }
  } catch (error) {
    return failure(command, error);
  }

  const body = readFileSync(file);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const init = await executor.execute({
    command: "content media upload-init",
    input: {
      filename: basename(file),
      // kind 仅 media upload 显式 --kind 时传递；知识上传由扩展名决定。
      ...(command === "content media upload" && input.kind !== undefined
        ? { kind: input.kind }
        : {}),
      sizeBytes,
      sha256
    }
  });
  if (!init.ok) {
    return { ...init, command };
  }

  const initData = init.data as RemoteUploadInitData;
  let mediaId: string;
  if (initData.status === "completed") {
    // 重复上传重放：素材已就绪，无需直传。
    mediaId = (initData.media as { id: string }).id;
    if (command === "content media upload") {
      // 输出形状与本地 upload 的素材视图一致。
      return { ...init, command, data: initData.media };
    }
  } else {
    mediaId = initData.mediaId as string;
    const ticket = initData.ticket as RemoteUploadTicketView;
    process.stderr.write(`直传 ${sizeBytes} 字节到对象存储…\n`);
    let response: Response;
    try {
      response = await fetch(ticket.url, {
        method: ticket.method,
        headers: ticket.headers,
        body,
        signal: AbortSignal.timeout(
          remoteTimeout(environment) ?? DEFAULT_PUT_TIMEOUT_MS
        )
      });
    } catch (error) {
      return failure(
        command,
        new DomainError("service_unavailable", "直传失败：无法连接对象存储", {
          retryable: true,
          cause: error
        })
      );
    }
    if (!response.ok) {
      // 不泄露票据 URL（含签名参数），只报告状态码。
      return failure(
        command,
        new DomainError(
          "service_unavailable",
          `直传失败（HTTP ${response.status}）`,
          { retryable: true }
        )
      );
    }

    const confirm = await executor.execute({
      command: "content media upload-confirm",
      input: { mediaId, sha256 }
    });
    if (!confirm.ok) {
      return { ...confirm, command };
    }
    if (command === "content media upload") {
      const confirmed = confirm.data as { media: unknown };
      return { ...confirm, command, data: confirmed.media };
    }
  }

  // agent knowledge add：素材就绪后从素材创建知识（与本地 add 同幂等键）。
  const added = await executor.execute({
    command: "agent knowledge add-from-media",
    input: {
      mediaId,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {})
    }
  });
  return { ...added, command };
}

// ---- 输出 ----

function human(result: CommandResult): string {  if (!result.ok) {
    return `${result.error.code}: ${result.error.message}`;
  }
  if (
    typeof result.data === "object" &&
    result.data !== null &&
    "items" in result.data
  ) {
    const items = (result.data as { items: unknown[] }).items;
    return items.length === 0
      ? "（无数据）"
      : JSON.stringify(items, null, 2);
  }
  return JSON.stringify(result.data, null, 2);
}

export async function runAdminCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const parsed = parse(argv);

  switch (parsed.kind) {
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "version":
      process.stdout.write(`kangmin-admin ${VERSION}\n`);
      return 0;
    case "completion":
      process.stdout.write(ZSH_COMPLETION);
      return 0;
    case "parse-error": {
      const result = failure(
        parsed.command,
        new DomainError("command_invalid", parsed.message ?? "命令无效")
      );
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stderr.write(`command_invalid: ${parsed.message}\n`);
      }
      return 2;
    }
  }

  const databasePath = resolve(
    environment.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );
  const mediaDirectory = resolve(
    environment.KANGMIN_ADMIN_MEDIA_DIR ??
      join(dirname(databasePath), "admin-media")
  );

  const baseUrl = remoteCommandBaseUrl(environment);
  // 凭据文件中的令牌只在其签发环境下使用：远程模式要求凭据记录的
  // baseUrl 与当前服务地址精确一致；本地模式只接受本地签发的凭据。
  // 环境变量 KANGMIN_ADMIN_TOKEN 由调用方显式提供，不受此限制。
  const stored = readCredentials(databasePath);
  const storedMatchesEnvironment =
    stored !== null && (stored.baseUrl ?? "") === (baseUrl ?? "");
  const token =
    environment.KANGMIN_ADMIN_TOKEN ??
    (storedMatchesEnvironment ? stored.token : undefined);
  let executor: AdminCommandExecutor;
  try {
    executor = createAdminExecutor(
      environment,
      databasePath,
      mediaDirectory,
      token
    );
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
    const input = { ...parsed.input };
    // 密码只从 stdin 读取，绝不进入命令行参数。
    if (parsed.command === "auth login" || parsed.command === "auth admins add") {
      const password = await readSecret("密码: ");
      if (password !== undefined) {
        input.password = password;
      }
    }
    // 模型 API Key 同样只从 stdin 读取（--api-key 是标志，不带值）。
    if (parsed.command === "agent model update" && input.apiKeyRequested === true) {
      const apiKey = await readSecret("API Key（输入不回显）: ");
      delete input.apiKeyRequested;
      if (apiKey !== undefined) {
        input.apiKey = apiKey;
      } else {
        process.stderr.write("警告: 未从 stdin 读到 API Key（空输入），本次不修改密钥\n");
      }
    }

    const remoteUpload =
      baseUrl !== undefined &&
      (parsed.command === "content media upload" ||
        parsed.command === "agent knowledge add");
    const result = remoteUpload
      ? await orchestrateRemoteUpload(
          executor,
          parsed.command as "content media upload" | "agent knowledge add",
          input,
          environment
        )
      : await executor.execute({
          command: parsed.command,
          input
        });

    if (result.ok && parsed.command === "auth login") {
      const data = result.data as { token: string; username: string; expiresAt: string };
      writeCredentials(databasePath, {
        token: data.token,
        username: data.username,
        expiresAt: data.expiresAt,
        baseUrl
      });
      // 令牌绝不进入任何输出。
      delete (result.data as Record<string, unknown>).token;
    }
    if (result.ok && parsed.command === "auth logout") {
      clearCredentials(databasePath);
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
    executor.close();
  }
}

process.exitCode = await runAdminCli(process.argv.slice(2));
