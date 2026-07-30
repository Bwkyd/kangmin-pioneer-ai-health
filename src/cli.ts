#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  capabilities,
  commandGroups,
  getCapability,
  getGroup,
  type Capability,
  type GroupName,
} from "./core/capabilities.ts";

const SCHEMA_VERSION = "1";

const EXIT = {
  success: 0,
  usage: 2,
  notFound: 3,
  conflict: 4,
  approvalRequired: 5,
  externalBlocked: 6,
  validation: 7,
} as const;

type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

function envelope(command: string, data: unknown, ok = true): string {
  return JSON.stringify(
    {
      ok,
      command,
      data,
      meta: { schemaVersion: SCHEMA_VERSION },
    },
    null,
    2,
  );
}

function renderRootHelp(): string {
  const groups = commandGroups
    .map(
      (group) =>
        `  ${group.name.padEnd(10)} ${group.priority === "core" ? "核心" : "次要"}  ${group.summary}`,
    )
    .join("\n");

  return `抗敏先锋 CLI

用法:
  kangmin <group> <command> [options]

四组命令:
${groups}

全局选项:
  --json       输出稳定 JSON 契约
  -h, --help   显示帮助

当前可执行发现命令:
  kangmin <group> status
  kangmin control capability list
  kangmin control capability show <issue-or-id>
  kangmin control capability check
`;
}

const groupCommands: Record<GroupName, string[]> = {
  consult: [
    "session start|answer|status",
    "safety check",
    "result show",
    "plan show",
  ],
  health: [
    "profile show|update",
    "allergen record|list|show|update",
    "symptom record|list",
    "scale record|history",
    "pollen status",
  ],
  content: [
    "learn list|show",
    "article create|import|preview|publish|unpublish",
    "video create|preview|submit|publish|unpublish",
  ],
  control: [
    "candidate list|show|register|diff",
    "approval status|approve|reject",
    "capability list|show|check",
    "audit list|show",
  ],
};

function renderGroupHelp(groupName: GroupName): string {
  const group = getGroup(groupName);
  const commands = groupCommands[groupName]
    .map((command) => `  kangmin ${groupName} ${command}`)
    .join("\n");

  return `${groupName}（${group?.priority === "core" ? "核心" : "次要"}）
${group?.summary}

计划命令:
${commands}

当前阶段可执行:
  kangmin ${groupName} status [--json]
${groupName === "control" ? "  kangmin control capability list|show|check [--json]\n" : ""}`;
}

function publicCapability(capability: Capability): Capability {
  return { ...capability };
}

function humanCapability(capability: Capability): string {
  const command = capability.command ?? capability.coveredBy?.join(", ") ?? "无";
  const lines = [
    `#${capability.issue} ${capability.summary}`,
    `状态: ${capability.status}`,
    `命令: ${command}`,
  ];
  if (capability.blocker) {
    lines.push(`阻塞: ${capability.blocker}`);
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): { args: string[]; json: boolean } {
  return {
    args: argv.filter((arg) => arg !== "--json"),
    json: argv.includes("--json"),
  };
}

function failure(
  command: string,
  json: boolean,
  exitCode: number,
  code: string,
  message: string,
): CliResult {
  if (json) {
    return {
      exitCode,
      stdout: envelope(command, { error: { code, message } }, false),
    };
  }
  return { exitCode, stderr: `${message}\n` };
}

function groupStatus(groupName: GroupName, json: boolean): CliResult {
  const group = getGroup(groupName)!;
  const owned = capabilities.filter(
    (capability) =>
      capability.group === groupName ||
      capability.coveredBy?.some((command) => command.startsWith(groupName)),
  );
  const data = {
    group,
    capabilities: owned.map(publicCapability),
  };
  if (json) {
    return {
      exitCode: EXIT.success,
      stdout: envelope(`${groupName} status`, data),
    };
  }
  const rows = owned
    .map(
      (capability) =>
        `  #${String(capability.issue).padEnd(3)} ${capability.status.padEnd(18)} ${capability.summary}`,
    )
    .join("\n");
  return {
    exitCode: EXIT.success,
    stdout: `${groupName}（${group.priority === "core" ? "核心" : "次要"}）\n${rows}\n`,
  };
}

function capabilityList(json: boolean): CliResult {
  if (json) {
    return {
      exitCode: EXIT.success,
      stdout: envelope(
        "control capability list",
        capabilities.map(publicCapability),
      ),
    };
  }
  return {
    exitCode: EXIT.success,
    stdout: `${capabilities.map(humanCapability).join("\n\n")}\n`,
  };
}

function capabilityShow(reference: string | undefined, json: boolean): CliResult {
  if (!reference) {
    return failure(
      "control capability show",
      json,
      EXIT.usage,
      "USAGE",
      "缺少 Issue 编号或能力 ID。",
    );
  }
  const capability = getCapability(reference);
  if (!capability) {
    return failure(
      "control capability show",
      json,
      EXIT.notFound,
      "NOT_FOUND",
      `未找到能力：${reference}`,
    );
  }
  return {
    exitCode: EXIT.success,
    stdout: json
      ? envelope("control capability show", publicCapability(capability))
      : `${humanCapability(capability)}\n`,
  };
}

function capabilityCheck(json: boolean): CliResult {
  const blocking = capabilities.filter(
    (capability) =>
      capability.status === "blocked_clinical" ||
      capability.status === "blocked_external",
  );
  const data = {
    releaseReady: blocking.length === 0,
    checkedIssues: capabilities.map((capability) => capability.issue),
    blocking: blocking.map(publicCapability),
  };
  if (json) {
    return {
      exitCode: EXIT.approvalRequired,
      stdout: envelope("control capability check", data, false),
    };
  }
  return {
    exitCode: EXIT.approvalRequired,
    stderr: `能力检查未通过：${blocking.length} 项仍被临床批准或外部条件阻塞。\n`,
    stdout: `${blocking.map(humanCapability).join("\n\n")}\n`,
  };
}

export function runCli(argv: string[]): CliResult {
  const { args, json } = parseArgs(argv);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    const data = { groups: commandGroups, schemaVersion: SCHEMA_VERSION };
    return {
      exitCode: EXIT.success,
      stdout: json ? envelope("help", data) : renderRootHelp(),
    };
  }

  const [groupName, command, action, reference] = args;
  const group = getGroup(groupName);
  if (!group) {
    return failure(
      groupName ?? "",
      json,
      EXIT.usage,
      "UNKNOWN_GROUP",
      `未知命令组：${groupName}。只允许 consult、health、content、control。`,
    );
  }

  if (!command || command === "--help" || command === "-h") {
    return {
      exitCode: EXIT.success,
      stdout: json
        ? envelope(`${groupName} help`, {
            group,
            commands: groupCommands[group.name],
          })
        : renderGroupHelp(group.name),
    };
  }

  if (command === "status") {
    return groupStatus(group.name, json);
  }

  if (group.name === "control" && command === "capability") {
    if (action === "list") {
      return capabilityList(json);
    }
    if (action === "show") {
      return capabilityShow(reference, json);
    }
    if (action === "check") {
      return capabilityCheck(json);
    }
  }

  return failure(
    `${groupName} ${command}`,
    json,
    EXIT.usage,
    "NOT_IMPLEMENTED",
    `命令尚未实现。运行 kangmin ${groupName} --help 查看已规划命令。`,
  );
}

function main(): void {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
