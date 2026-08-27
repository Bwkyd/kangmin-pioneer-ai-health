import assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createApplication } from "@kangmin/runtime/composition-root";
import { seedContent } from "./content-fixture.js";
import { writeConsentForTest } from "./consent-fixture.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../apps/kangmin-cli/dist/kangmin.js");

function run(
  args: string[],
  environment: Record<string, string>
): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
  result.stderr = stripNodeRuntimeWarnings(result.stderr);
  return result;
}

/**
 * Node 22 对实验性的 node:sqlite 会向 stderr 打印 ExperimentalWarning；
 * 这是运行时版本噪音，不属于 CLI 自身诊断输出，断言前剔除。
 */
function stripNodeRuntimeWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        !/^\(node:\d+\) (Experimental)?Warning/u.test(line) &&
        !line.startsWith("(Use `node --trace-warnings")
    )
    .join("\n");
}

test("真实 CLI 子进程跨重启持久化，JSON stdout 保持纯净", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-cli-"));
  const databasePath = join(directory, "records.sqlite");
  const bootstrap = createApplication(databasePath);
  const session =
    await bootstrap.sessions.createDevelopmentSession("patient-cli");
  bootstrap.close();
  // record 写入需 health_data 授权（issue-155 fail-closed）。
  await writeConsentForTest(databasePath, session.patientId, "health_data");
  const token = session.token;

  const environment = {
    KANGMIN_DB_PATH: databasePath,
    KANGMIN_SESSION_TOKEN: token
  };
  const add = run([
    "record", "symptom", "add",
    "--local-date", "2026-07-31",
    "--nasal-congestion", "2",
    "--nasal-itching", "1",
    "--sneezing", "3",
    "--runny-nose", "2",
    "--idempotency-key", "cli-20260731",
    "--json"
  ], environment);

  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.stderr, "");
  assert.equal(add.stdout.trim().split("\n").length, 1);
  const created = JSON.parse(add.stdout) as {
    ok: boolean;
    data: { id: string; tnssTotal: number };
  };
  assert.equal(created.ok, true);
  assert.equal(created.data.tnssTotal, 8);

  const list = run(
    ["record", "symptom", "list", "--json"],
    environment
  );
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as {
    ok: boolean;
    data: { items: Array<{ id: string }> };
  };
  assert.equal(listed.data.items[0]?.id, created.data.id);

  const crossBootstrap = createApplication(databasePath);
  const otherToken =
    (await crossBootstrap.sessions.createDevelopmentSession("patient-other")).token;
  crossBootstrap.close();
  const cross = run(
    ["record", "symptom", "show", created.data.id, "--json"],
    {
      KANGMIN_DB_PATH: databasePath,
      KANGMIN_SESSION_TOKEN: otherToken
    }
  );
  assert.equal(cross.status, 3);
  const denied = JSON.parse(cross.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(denied.error.code, "resource_not_found");
});

test("存储启动失败与空列表不同", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-storage-"));
  const result = run(
    ["record", "symptom", "list", "--json"],
    {
      KANGMIN_DB_PATH: directory,
      KANGMIN_SESSION_TOKEN: "not-used"
    }
  );
  assert.equal(result.status, 6);
  const body = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "storage_unavailable");
});

async function e2eFixture(): Promise<{
  directory: string;
  databasePath: string;
  environment: Record<string, string>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-cli-"));
  const databasePath = join(directory, "records.sqlite");
  const bootstrap = createApplication(databasePath);
  const session =
    await bootstrap.sessions.createDevelopmentSession("patient-cli");
  bootstrap.close();
  // record 写入需 health_data 授权（issue-155 fail-closed）：dev 会话患者
  // 无本地账号，授权经仓储层补记（见 consent-fixture）。
  await writeConsentForTest(databasePath, session.patientId, "health_data");
  return {
    directory,
    databasePath,
    environment: {
      KANGMIN_DB_PATH: databasePath,
      KANGMIN_SESSION_TOKEN: session.token
    }
  };
}

test("档案、暴露和用药通过真实 CLI 子进程跨重启持久化", async () => {
  const { databasePath, environment } = await e2eFixture();

  const emptyProfile = run(
    ["record", "profile", "show", "--json"],
    environment
  );
  assert.equal(emptyProfile.status, 0, emptyProfile.stderr);
  assert.equal(emptyProfile.stdout.trim().split("\n").length, 1);
  const emptyBody = JSON.parse(emptyProfile.stdout) as {
    ok: boolean;
    data: { revision: number };
  };
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.data.revision, 0);

  const profileUpdate = run([
    "record", "profile", "update",
    "--expected-revision", "0",
    "--display-name", "小王",
    "--birth-date", "1990-05-20",
    "--sex", "male",
    "--allergy-history", "尘螨",
    "--json"
  ], environment);
  assert.equal(profileUpdate.status, 0, profileUpdate.stderr);
  const profileBody = JSON.parse(profileUpdate.stdout) as {
    ok: boolean;
    data: { revision: number; displayName: string };
  };
  assert.equal(profileBody.data.revision, 1);
  assert.equal(profileBody.data.displayName, "小王");

  const exposureAdd = run([
    "record", "exposure", "add",
    "--local-date", "2026-07-10",
    "--factor", "pollen",
    "--factor", "dust_mite",
    "--idempotency-key", "cli-exposure-1",
    "--json"
  ], environment);
  assert.equal(exposureAdd.status, 0, exposureAdd.stderr);
  const exposureBody = JSON.parse(exposureAdd.stdout) as {
    ok: boolean;
    data: { id: string; factors: string[]; revision: number };
  };
  assert.deepEqual(exposureBody.data.factors, ["pollen", "dust_mite"]);

  const medicationAdd = run([
    "record", "medication", "add",
    "--local-date", "2026-07-11",
    "--name", "氯雷他定",
    "--dosage", "10mg",
    "--actual-use", "每晚一次",
    "--idempotency-key", "cli-medication-1",
    "--json"
  ], environment);
  assert.equal(medicationAdd.status, 0, medicationAdd.stderr);
  const medicationBody = JSON.parse(medicationAdd.stdout) as {
    ok: boolean;
    data: { id: string; medicationName: string };
  };
  assert.equal(medicationBody.data.medicationName, "氯雷他定");

  const overview = run(["record", "overview", "--json"], environment);
  assert.equal(overview.status, 0, overview.stderr);
  const overviewBody = JSON.parse(overview.stdout) as {
    ok: boolean;
    data: { recentSymptomDate: string | null; recentExposureDate: string | null };
  };
  assert.equal(overviewBody.data.recentSymptomDate, null);
  assert.equal(overviewBody.data.recentExposureDate, "2026-07-10");

  const calendar = run(
    ["record", "calendar", "--month", "2026-07", "--json"],
    environment
  );
  assert.equal(calendar.status, 0, calendar.stderr);
  const calendarBody = JSON.parse(calendar.stdout) as {
    ok: boolean;
    data: { days: Array<{ localDate: string }> };
  };
  assert.deepEqual(
    calendarBody.data.days.map((day) => day.localDate),
    ["2026-07-10", "2026-07-11"]
  );

  const exposureDeleteWithoutYes = run([
    "record", "exposure", "delete",
    exposureBody.data.id,
    "--expected-revision", "1",
    "--json"
  ], environment);
  assert.equal(exposureDeleteWithoutYes.status, 5, exposureDeleteWithoutYes.stderr);
  const deniedBody = JSON.parse(exposureDeleteWithoutYes.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(deniedBody.error.code, "confirmation_required");

  const exposureDelete = run([
    "record", "exposure", "delete",
    exposureBody.data.id,
    "--expected-revision", "1",
    "--yes",
    "--json"
  ], environment);
  assert.equal(exposureDelete.status, 0, exposureDelete.stderr);

  const exposureGone = run(
    ["record", "exposure", "show", exposureBody.data.id, "--json"],
    environment
  );
  assert.equal(exposureGone.status, 3);
  const goneBody = JSON.parse(exposureGone.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(goneBody.error.code, "resource_not_found");

  const medicationUpdate = run([
    "record", "medication", "update",
    medicationBody.data.id,
    "--expected-revision", "1",
    "--dosage", "20mg",
    "--json"
  ], environment);
  assert.equal(medicationUpdate.status, 0, medicationUpdate.stderr);
  const medicationUpdated = JSON.parse(medicationUpdate.stdout) as {
    ok: boolean;
    data: { revision: number; dosage: string };
  };
  assert.equal(medicationUpdated.data.revision, 2);
  assert.equal(medicationUpdated.data.dosage, "20mg");

  const medicationDelete = run([
    "record", "medication", "delete",
    medicationBody.data.id,
    "--expected-revision", "2",
    "--yes",
    "--json"
  ], environment);
  assert.equal(medicationDelete.status, 0, medicationDelete.stderr);

  const crossRestart = createApplication(databasePath);
  crossRestart.close();
  const finalProfile = run(["record", "profile", "show", "--json"], environment);
  assert.equal(finalProfile.status, 0, finalProfile.stderr);
  const finalBody = JSON.parse(finalProfile.stdout) as {
    ok: boolean;
    data: { displayName: string };
  };
  assert.equal(finalBody.data.displayName, "小王");
});

test("症状删除、趋势和参数错误通过真实 CLI 验证", async () => {
  const { environment } = await e2eFixture();

  const add = run([
    "record", "symptom", "add",
    "--local-date", "2026-07-15",
    "--nasal-congestion", "2",
    "--nasal-itching", "1",
    "--sneezing", "3",
    "--runny-nose", "2",
    "--idempotency-key", "cli-symptom-delete",
    "--json"
  ], environment);
  assert.equal(add.status, 0, add.stderr);
  const created = JSON.parse(add.stdout) as {
    ok: boolean;
    data: { id: string };
  };

  const trend = run([
    "record", "trend",
    "--from", "2026-07-01",
    "--to", "2026-07-31",
    "--json"
  ], environment);
  assert.equal(trend.status, 0, trend.stderr);
  const trendBody = JSON.parse(trend.stdout) as {
    ok: boolean;
    data: { items: Array<{ localDate: string; tnssTotal: number }> };
  };
  assert.equal(trendBody.data.items.length, 1);
  assert.equal(trendBody.data.items[0]?.tnssTotal, 8);

  const reversedTrend = run([
    "record", "trend",
    "--from", "2026-07-31",
    "--to", "2026-07-01",
    "--json"
  ], environment);
  assert.equal(reversedTrend.status, 7);
  const reversedBody = JSON.parse(reversedTrend.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(reversedBody.error.code, "validation_failed");

  const badOption = run([
    "record", "symptom", "add",
    "--local-date", "2026-07-15",
    "--nasal-congestion", "2",
    "--idempotency-key", "cli-bad",
    "--frobnicate", "x",
    "--json"
  ], environment);
  assert.equal(badOption.status, 2);
  const badBody = JSON.parse(badOption.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(badBody.error.code, "command_invalid");

  const deleteWithoutYes = run([
    "record", "symptom", "delete",
    created.data.id,
    "--expected-revision", "1",
    "--json"
  ], environment);
  assert.equal(deleteWithoutYes.status, 5);
  const denied = JSON.parse(deleteWithoutYes.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(denied.error.code, "confirmation_required");

  const deleteWithYes = run([
    "record", "symptom", "delete",
    created.data.id,
    "--expected-revision", "1",
    "--yes",
    "--json"
  ], environment);
  assert.equal(deleteWithYes.status, 0, deleteWithYes.stderr);
  const deletedBody = JSON.parse(deleteWithYes.stdout) as {
    ok: boolean;
    data: { deleted: boolean };
  };
  assert.equal(deletedBody.data.deleted, true);

  const missingId = run(
    ["record", "symptom", "delete", "--json"],
    environment
  );
  assert.equal(missingId.status, 2);
  const missingIdBody = JSON.parse(missingId.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(missingIdBody.error.code, "command_invalid");
});

test("Browse 真实 CLI 无需身份即可搜索和读取已发布内容", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-cli-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  const environment = { KANGMIN_DB_PATH: databasePath };

  const search = run(
    ["browse", "article", "search", "换季", "--json"],
    environment
  );
  assert.equal(search.status, 0, search.stderr);
  assert.equal(search.stdout.trim().split("\n").length, 1);
  const searchBody = JSON.parse(search.stdout) as {
    data: { items: Array<{ id: string }> };
  };
  assert.deepEqual(searchBody.data.items.map((item) => item.id), [
    "article-public"
  ]);

  const hidden = run(
    ["browse", "article", "show", "article-draft", "--json"],
    environment
  );
  assert.equal(hidden.status, 3);
  const hiddenBody = JSON.parse(hidden.stdout) as {
    error: { code: string };
  };
  assert.equal(hiddenBody.error.code, "resource_not_found");
});

test("Agent 真实 CLI 子进程完成安全会话并跨进程恢复", async () => {
  const { environment } = await e2eFixture();
  const start = run(["agent", "start", "--json"], environment);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout.trim().split("\n").length, 1);
  const started = JSON.parse(start.stdout) as {
    ok: boolean;
    data: { id: string; revision: number; nextQuestion: { key: string } };
  };
  assert.equal(started.data.nextQuestion.key, "urgentHelp");

  const continued = run([
    "agent", "continue", started.data.id,
    "--expected-revision", "1",
    "--question", "urgentHelp",
    "--answer", "yes",
    "--json"
  ], environment);
  assert.equal(continued.status, 0, continued.stderr);
  const continuedBody = JSON.parse(continued.stdout) as {
    data: { status: string; outcome: string; approvedPlanAvailable: boolean };
  };
  assert.equal(continuedBody.data.status, "safety_blocked");
  assert.equal(continuedBody.data.outcome, "urgent_help_required");
  assert.equal(continuedBody.data.approvedPlanAvailable, false);

  const resumed = run(
    ["agent", "resume", started.data.id, "--json"],
    environment
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedBody = JSON.parse(resumed.stdout) as {
    data: { revision: number; decisionEvidence: { rulePackVersion: string } };
  };
  assert.equal(resumedBody.data.revision, 2);
  assert.equal(
    resumedBody.data.decisionEvidence.rulePackVersion,
    "agent-safety-shell-v1"
  );
});

test("裸 agent continue（缺省 ID）续接最近待答会话；无待答 exit 3；匿名 exit 9", async () => {
  const { environment } = await e2eFixture();

  // 无待答会话：裸 continue → resource_not_found（exit 3）。
  const empty = run([
    "agent", "continue",
    "--expected-revision", "1",
    "--question", "urgentHelp",
    "--answer", "no",
    "--json"
  ], environment);
  assert.equal(empty.status, 3, empty.stderr);
  assert.equal(
    (JSON.parse(empty.stdout) as { error: { code: string } }).error.code,
    "resource_not_found"
  );

  const start = run(["agent", "start", "--json"], environment);
  assert.equal(start.status, 0, start.stderr);
  const started = JSON.parse(start.stdout) as { data: { id: string } };

  // 缺省 ID：CLI 解析放行，续接最近待答会话。
  const bare = run([
    "agent", "continue",
    "--expected-revision", "1",
    "--question", "urgentHelp",
    "--answer", "yes",
    "--json"
  ], environment);
  assert.equal(bare.status, 0, bare.stderr);
  const bareBody = JSON.parse(bare.stdout) as {
    data: { id: string; status: string };
  };
  assert.equal(bareBody.data.id, started.data.id);
  assert.equal(bareBody.data.status, "safety_blocked");

  // 匿名裸 continue → authentication_required（exit 9，保持不变）。
  const anonymous = run([
    "agent", "continue",
    "--expected-revision", "1",
    "--question", "urgentHelp",
    "--answer", "no",
    "--json"
  ], { KANGMIN_DB_PATH: environment.KANGMIN_DB_PATH ?? "" });
  assert.equal(anonymous.status, 9);
  assert.equal(
    (JSON.parse(anonymous.stdout) as { error: { code: string } }).error.code,
    "authentication_required"
  );

  // agent resume 仍必须显式带 ID（解析错误 exit 2）。
  const resume = run(["agent", "resume", "--json"], environment);
  assert.equal(resume.status, 2);
});

test("Agent 对话命令通过真实 CLI：exec/feedback/快捷入口；患者侧 test run 关闭", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-cli-agent-"));
  const databasePath = join(directory, "agent.sqlite");
  const environment = { KANGMIN_DB_PATH: databasePath };

  // 非交互 exec：匿名一次性体验，返回结构化状态（不等待确认）。
  const exec = run([
    "agent", "exec", "我最近鼻塞", "--json"
  ], environment);
  assert.equal(exec.status, 0, exec.stderr);
  assert.equal(exec.stdout.trim().split("\n").length, 1);
  const execBody = JSON.parse(exec.stdout) as {
    ok: boolean;
    data: {
      conversationId: string;
      message: { content: string; decisionId: string | null };
      verdict: { outcome: string; nextQuestions: Array<{ prompt: string }> };
    };
  };
  assert.equal(execBody.ok, true);
  assert.ok(execBody.data.conversationId.length > 0);
  assert.equal(execBody.data.verdict.outcome, "need_more_information");
  assert.ok(execBody.data.message.decisionId !== null);

  assert.equal(execBody.data.verdict.nextQuestions[0]?.prompt, "您打喷嚏的情况是？");

  // 续接同一对话：生产页面严格由 Q1 推进到 Q2，不插入旧安全筛查题。
  const continued = run([
    "agent", "exec", "q1=A",
    "--conversation", execBody.data.conversationId,
    "--json"
  ], environment);
  assert.equal(continued.status, 0, continued.stderr);
  const continuedBody = JSON.parse(continued.stdout) as {
    data: {
      closed: boolean;
      verdict: { nextQuestions: Array<{ prompt: string }> };
    };
  };
  assert.equal(continuedBody.data.closed, false);
  assert.equal(continuedBody.data.verdict.nextQuestions[0]?.prompt, "您的鼻涕通常是？");

  // 快捷入口：kangmin <消息> ≡ agent start --message。
  const shortcut = run(["我最近鼻塞", "--json"], environment);
  assert.equal(shortcut.status, 0, shortcut.stderr);
  const shortcutBody = JSON.parse(shortcut.stdout) as {
    command: string;
    data: { conversationId: string };
  };
  assert.equal(shortcutBody.command, "agent start");
  assert.ok(shortcutBody.data.conversationId.length > 0);

  // 患者侧 agent test run：评审 R2 P0——模拟链路属于管理端，患者侧返回
  // capability_unavailable（exit 6），绝不输出完整 ClinicalVerdict。
  const testRun = run([
    "agent", "test", "run",
    "--answer", "thirst=yes",
    "--answer", "sleep_affected=no",
    "--json"
  ], environment);
  assert.equal(testRun.status, 6, testRun.stderr);
  const testRunBody = JSON.parse(testRun.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(testRunBody.ok, false);
  assert.equal(testRunBody.error.code, "capability_unavailable");
  assert.match(testRunBody.error.message, /kangmin-admin/u);

  // feedback：helpful 可记录；非法评分被拒绝。
  const feedback = run([
    "agent", "feedback", execBody.data.conversationId,
    "--rating", "helpful", "--reason", "解释清楚",
    "--json"
  ], environment);
  assert.equal(feedback.status, 0, feedback.stderr);
  const feedbackBody = JSON.parse(feedback.stdout) as {
    ok: boolean;
    data: { rating: string };
  };
  assert.equal(feedbackBody.data.rating, "helpful");

  const badRating = run([
    "agent", "feedback", execBody.data.conversationId,
    "--rating", "neutral", "--json"
  ], environment);
  assert.equal(badRating.status, 7);
  const badBody = JSON.parse(badRating.stdout) as {
    error: { code: string };
  };
  assert.equal(badBody.error.code, "validation_failed");

  // 匿名不能列出会话。
  const list = run(["agent", "conversations", "list", "--json"], environment);
  assert.equal(list.status, 9);
  const listBody = JSON.parse(list.stdout) as { error: { code: string } };
  assert.equal(listBody.error.code, "authentication_required");
});

test("help 免登录、未知命令组 command_invalid（与登录状态无关）、裸词仍进 Agent 管线", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-help-"));
  const environment = { KANGMIN_DB_PATH: join(directory, "records.sqlite") };

  // 裸 help 无 token：退出 0，输出帮助（外部评审 P1-10）。
  const help = run(["help"], environment);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：/u);

  // 未知命令组无 token：command_invalid exit 2，绝不漂移成
  // authentication_required（exit 9）。
  const unknown = run(["foo", "bar", "--json"], environment);
  assert.equal(unknown.status, 2);
  const unknownBody = JSON.parse(unknown.stdout) as {
    error: { code: string };
  };
  assert.equal(unknownBody.error.code, "command_invalid");

  // 已登录状态下的未知命令同样是 command_invalid（与登录无关）。
  const databasePath = join(directory, "records.sqlite");
  const bootstrap = createApplication(databasePath);
  let token = "";
  try {
    token = (await bootstrap.sessions.createDevelopmentSession("patient-help")).token;
  } finally {
    bootstrap.close();
  }
  const unknownLoggedIn = run(
    ["foo", "bar", "--json"],
    { KANGMIN_DB_PATH: databasePath, KANGMIN_SESSION_TOKEN: token }
  );
  assert.equal(unknownLoggedIn.status, 2);

  // 笔误裸词（如 recrod）按特性进入 Agent 管线，不当作命令报错。
  const typo = run(
    ["recrod", "--json"],
    { KANGMIN_DB_PATH: databasePath, KANGMIN_SESSION_TOKEN: token }
  );
  assert.equal(typo.status, 0, typo.stderr);
  const typoBody = JSON.parse(typo.stdout) as {
    command: string;
    data: { message: { content: string } | null };
  };
  assert.equal(typoBody.command, "agent start");
  assert.ok(typeof typoBody.data.message?.content === "string");
});
