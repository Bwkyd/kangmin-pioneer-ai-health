/**
 * 远程上传 CLI 编排 E2E：真实 CLI 子进程（KANGMIN_API_BASE_URL 远程模式）
 * + in-process 命令服务 + 真实 S3 兼容端点（MinIO），验证
 * "申请票据 → 预签名直传 → 校验和确认"三步编排。
 *
 * 覆盖：
 * - 真实 PNG 上传 → exit 0、输出素材 id；重复上传同文件 → 重放同 id；
 * - 类型伪装（mp4 字节命名 .png）→ confirm 拒绝、validation_failed、
 *   素材标记 failed；
 * - agent knowledge add 一个 .md → 建知识 → index/enable 后 search-test 命中；
 * - init 后中断的孤儿会话：--yes 门禁（confirmation_required）与
 *   cleanup-orphans 清理（cleaned ≥ 1）。
 *
 * 运行前需设置 KANGMIN_TEST_S3_ENDPOINT 与 KANGMIN_TEST_S3_BUCKET
 * （如 http://127.0.0.1:9900 与 kangmin-test），bucket 不存在时由实现
 * 自动创建；未配置时全部用例 skip。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { S3ObjectStorage } from "../infrastructure/s3-object-storage.js";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const ENDPOINT = process.env.KANGMIN_TEST_S3_ENDPOINT;
const BUCKET = process.env.KANGMIN_TEST_S3_BUCKET;
const SKIP_REASON =
  "未配置 KANGMIN_TEST_S3_ENDPOINT / KANGMIN_TEST_S3_BUCKET";
const SKIP =
  ENDPOINT === undefined || BUCKET === undefined ? SKIP_REASON : false;

const here = dirname(fileURLToPath(import.meta.url));
const adminCli = join(here, "../cli/kangmin-admin.js");

interface RunningServer {
  patient: ReturnType<typeof createApplication>;
  admin: ReturnType<typeof createAdminApplication>;
  server: ReturnType<typeof createKangminHttpServer>;
  origin: string;
  databasePath: string;
  token: string;
}

async function startServer(): Promise<RunningServer> {
  assert.ok(ENDPOINT !== undefined && BUCKET !== undefined, SKIP_REASON);
  const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-upload-"));
  const databasePath = join(directory, "server.sqlite");
  const bootstrap = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "media")
  });
  const token =
    (await bootstrap.sessions.createDevelopmentSession("remote-upload-admin"))
      .token;
  bootstrap.close();

  const patient = createApplication(databasePath);
  const admin = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "media"),
    objectStorage: new S3ObjectStorage({
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: "us-east-1",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin"
    })
  });
  const server = createKangminHttpServer(patient, {
    appEnvironment: "integration",
    adminApplication: admin,
    serviceVersion: "0.1.0"
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    assert.fail("remote upload server did not expose a TCP address");
  }
  return {
    patient,
    admin,
    server,
    origin: `http://127.0.0.1:${address.port}`,
    databasePath,
    token
  };
}

async function stopServer(server: RunningServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  server.patient.close();
  server.admin.close();
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runAdminCli(
  server: RunningServer,
  args: string[]
): Promise<CliResult> {
  const child = spawn(process.execPath, [adminCli, ...args], {
    env: {
      ...process.env,
      KANGMIN_API_BASE_URL: server.origin,
      KANGMIN_APP_ENV: "integration",
      KANGMIN_ADMIN_TOKEN: server.token,
      // 凭据文件隔离到独立目录，避免读写真实本地凭据。
      KANGMIN_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "kangmin-remote-upload-cli-")),
        "cli.sqlite"
      )
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { status, stdout, stderr };
}

interface MediaView {
  id: string;
  kind: string;
  filename: string;
  status: string;
  sha256: string | null;
}

/** 合法 PNG 头（魔数嗅探只校验文件头，内容不必是完整图片）。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

/** ISO BMFF（mp4）ftyp 盒头：第 4–7 字节为 "ftyp"。 */
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00
]);

test("远程编排上传：PNG 上传成功，重复上传重放同一素材", { skip: SKIP }, async () => {
  const server = await startServer();
  try {
    const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-upload-file-"));
    const file = join(directory, "nose-care.png");
    writeFileSync(file, PNG_BYTES);

    const first = await runAdminCli(server, [
      "content", "media", "upload", file, "--json"
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const uploaded = (
      JSON.parse(first.stdout) as { data: MediaView }
    ).data;
    assert.ok(uploaded.id.startsWith("med_"));
    assert.equal(uploaded.kind, "image");
    assert.equal(uploaded.filename, "nose-care.png");
    assert.equal(uploaded.status, "ready");
    // --json 纯净性：stdout 只有一个 JSON 对象，进度只进 stderr。
    assert.match(first.stderr, /直传/u);

    const second = await runAdminCli(server, [
      "content", "media", "upload", file, "--json"
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const replayed = (
      JSON.parse(second.stdout) as { data: MediaView }
    ).data;
    assert.equal(replayed.id, uploaded.id);
    assert.equal(replayed.status, "ready");
    // 重放不再直传。
    assert.equal(second.stderr.includes("直传"), false);
  } finally {
    await stopServer(server);
  }
});

test("远程编排上传：mp4 字节伪装 .png → confirm 拒绝并标记 failed", { skip: SKIP }, async () => {
  const server = await startServer();
  try {
    const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-upload-file-"));
    const file = join(directory, "spoofed.png");
    writeFileSync(file, MP4_BYTES);

    const upload = await runAdminCli(server, [
      "content", "media", "upload", file, "--json"
    ]);
    assert.equal(upload.status, 7, upload.stderr || upload.stdout);
    const failure = JSON.parse(upload.stdout) as {
      error: { code: string };
    };
    assert.equal(failure.error.code, "validation_failed");

    const list = await runAdminCli(server, [
      "content", "media", "list", "--json"
    ]);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const items = (
      JSON.parse(list.stdout) as { data: { items: MediaView[] } }
    ).data.items;
    const spoofed = items.find((item) => item.filename === "spoofed.png");
    assert.ok(spoofed !== undefined);
    assert.equal(spoofed.status, "failed");
  } finally {
    await stopServer(server);
  }
});

test("远程编排 agent knowledge add：.md 上传建知识并可检索", { skip: SKIP }, async () => {
  const server = await startServer();
  try {
    const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-upload-file-"));
    const file = join(directory, "pollen-guide.md");
    writeFileSync(
      file,
      "# 花粉季鼻腔护理\n\n花粉季外出建议佩戴口罩，回家后可盐水洗鼻。\n"
    );

    const added = await runAdminCli(server, [
      "agent", "knowledge", "add", file,
      "--source", "远程上传 E2E",
      "--json"
    ]);
    assert.equal(added.status, 0, added.stderr || added.stdout);
    const knowledge = (
      JSON.parse(added.stdout) as { data: { id: string; status: string } }
    ).data;
    assert.ok(knowledge.id.startsWith("kno_"));
    assert.equal(knowledge.status, "processing");

    const indexed = await runAdminCli(server, [
      "agent", "knowledge", "index", knowledge.id, "--json"
    ]);
    assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
    const enabled = await runAdminCli(server, [
      "agent", "knowledge", "enable", knowledge.id, "--yes", "--json"
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);

    const search = await runAdminCli(server, [
      "agent", "knowledge", "search-test", "盐水洗鼻", "--json"
    ]);
    assert.equal(search.status, 0, search.stderr || search.stdout);
    const hits = (
      JSON.parse(search.stdout) as {
        data: { items: Array<{ knowledgeId: string }> };
      }
    ).data.items;
    assert.ok(hits.some((hit) => hit.knowledgeId === knowledge.id));
  } finally {
    await stopServer(server);
  }
});

test("孤儿上传会话：--yes 门禁与 cleanup-orphans 清理", { skip: SKIP }, async () => {
  const server = await startServer();
  try {
    // init 后不 PUT（客户端中断残留 processing 草稿行）。
    const init = await server.admin.execute({
      command: "content media upload-init",
      adminToken: server.token,
      input: {
        filename: "orphan.png",
        sizeBytes: PNG_BYTES.length,
        sha256: "0".repeat(64)
      }
    });
    assert.equal(init.ok, true);
    const orphan = init.data as { status: string; mediaId: string };
    assert.equal(orphan.status, "uploading");

    // 高影响操作门禁：未带 --yes（yes）→ confirmation_required。
    const blocked = await server.admin.execute({
      command: "content media cleanup-orphans",
      adminToken: server.token,
      input: { olderThanMinutes: 5 }
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.error.code, "confirmation_required");
    }

    // 孤儿判定看 updated_at：把草稿行改旧（模拟中断已久），再清理。
    const connection = new DatabaseSync(server.databasePath);
    try {
      connection.prepare(
        "UPDATE content_resource_media SET updated_at = ? WHERE id = ?"
      ).run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), orphan.mediaId);
    } finally {
      connection.close();
    }

    const cleaned = await server.admin.execute({
      command: "content media cleanup-orphans",
      adminToken: server.token,
      input: { yes: true, olderThanMinutes: 5 }
    });
    assert.equal(cleaned.ok, true);
    if (cleaned.ok) {
      assert.ok(
        (cleaned.data as { cleaned: number }).cleaned >= 1,
        "expected at least one orphan cleaned"
      );
    }

    const listed = await server.admin.execute({
      command: "content media list",
      adminToken: server.token
    });
    assert.equal(listed.ok, true);
    if (listed.ok) {
      const items = (listed.data as { items: MediaView[] }).items;
      assert.equal(
        items.some((item) => item.id === orphan.mediaId),
        false
      );
    }
  } finally {
    await stopServer(server);
  }
});
