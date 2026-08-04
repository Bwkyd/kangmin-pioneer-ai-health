import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { writeConsentForTest } from "./consent-fixture.js";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const here = dirname(fileURLToPath(import.meta.url));
const patientCli = join(here, "../cli/kangmin.js");
const adminCli = join(here, "../cli/kangmin-admin.js");
interface RunningServer {
  patient: ReturnType<typeof createApplication>;
  admin: ReturnType<typeof createAdminApplication>;
  server: ReturnType<typeof createKangminHttpServer>;
  origin: string;
}

async function startServer(databasePath: string): Promise<RunningServer> {
  const patient = createApplication(databasePath);
  const admin = createAdminApplication(databasePath, {
    mediaDirectory: join(dirname(databasePath), "media")
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
    assert.fail("remote CLI server did not expose a TCP address");
  }
  return {
    patient,
    admin,
    server,
    origin: `http://127.0.0.1:${address.port}`
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

async function runCli(
  cli: string,
  args: string[],
  origin: string,
  tokenName: "KANGMIN_SESSION_TOKEN" | "KANGMIN_ADMIN_TOKEN",
  token: string
) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      KANGMIN_API_BASE_URL: origin,
      KANGMIN_APP_ENV: "integration",
      [tokenName]: token
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

test("真实远程 CLI：患者/管理员隔离、协议校验和服务重启持久化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-cli-"));
  const databasePath = join(directory, "remote.sqlite");
  const patientBootstrap = createApplication(databasePath);
  const patientSession =
    await patientBootstrap.sessions.createDevelopmentSession("remote-patient");
  patientBootstrap.close();
  // record 写入需 health_data 授权（issue-155 fail-closed）。
  await writeConsentForTest(databasePath, patientSession.patientId, "health_data");
  const patientToken = patientSession.token;
  const adminBootstrap = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "media")
  });
  const adminToken =
    (await adminBootstrap.sessions.createDevelopmentSession("remote-admin")).token;
  adminBootstrap.close();

  let server = await startServer(databasePath);
  try {
    const metaResponse = await fetch(`${server.origin}/v1/meta`);
    assert.equal(metaResponse.status, 200);
    assert.deepEqual(await metaResponse.json(), {
      service: "kangmin-command-service",
      serviceVersion: "0.1.0",
      protocolVersion: "1",
      schemaVersion: "1",
      audiences: ["patient", "admin"]
    });

    const add = await runCli(patientCli, [
      "record", "symptom", "add",
      "--local-date", "2026-07-31",
      "--nasal-congestion", "2",
      "--nasal-itching", "1",
      "--sneezing", "3",
      "--runny-nose", "2",
      "--idempotency-key", "remote-e2e",
      "--json"
    ], server.origin, "KANGMIN_SESSION_TOKEN", patientToken);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const added = JSON.parse(add.stdout) as { data: { tnssTotal: number } };
    assert.equal(added.data.tnssTotal, 8);

    const adminList = await runCli(
      adminCli,
      ["content", "article", "list", "--json"],
      server.origin,
      "KANGMIN_ADMIN_TOKEN",
      adminToken
    );
    assert.equal(adminList.status, 0, adminList.stderr || adminList.stdout);

    const wrongAdmin = await fetch(`${server.origin}/v1/admin/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${patientToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "1",
        command: "content article list",
        input: {},
        requestId: "wrong-admin"
      })
    });
    assert.equal(wrongAdmin.status, 401);

    const wrongPatient = await fetch(`${server.origin}/v1/patient/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "1",
        command: "record symptom list",
        input: {},
        requestId: "wrong-patient"
      })
    });
    assert.equal(wrongPatient.status, 401);

    const incompatible = await fetch(`${server.origin}/v1/patient/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "2",
        command: "browse",
        input: {},
        requestId: "bad-schema"
      })
    });
    assert.equal(incompatible.status, 426);
    const incompatibleBody = await incompatible.json() as {
      error: { code: string };
    };
    assert.equal(incompatibleBody.error.code, "protocol_incompatible");

    const incomplete = await fetch(`${server.origin}/v1/patient/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1",
        command: "browse"
      })
    });
    assert.equal(incomplete.status, 400);
    const incompleteBody = await incomplete.json() as {
      error: { code: string };
    };
    assert.equal(incompleteBody.error.code, "command_invalid");

    await stopServer(server);
    server = await startServer(databasePath);
    const list = await runCli(
      patientCli,
      ["record", "symptom", "list", "--json"],
      server.origin,
      "KANGMIN_SESSION_TOKEN",
      patientToken
    );
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const listed = JSON.parse(list.stdout) as {
      data: { items: Array<{ tnssTotal: number }> };
    };
    assert.equal(listed.data.items[0]?.tnssTotal, 8);
  } finally {
    if (server.server.listening) {
      await stopServer(server);
    }
  }
});

interface AdminCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runAdminCliWithCredentials(
  args: string[],
  origin: string,
  credentialsDirectory: string,
  extraEnvironment: Record<string, string> = {}
): Promise<AdminCliResult> {
  const child = spawn(process.execPath, [adminCli, ...args], {
    env: {
      ...process.env,
      KANGMIN_API_BASE_URL: origin,
      KANGMIN_APP_ENV: "integration",
      KANGMIN_DB_PATH: join(credentialsDirectory, "cli.sqlite"),
      ...extraEnvironment
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

function writeAdminCredentials(
  credentialsDirectory: string,
  credentials: Record<string, string>
): void {
  writeFileSync(
    join(credentialsDirectory, ".kangmin-admin.credentials.json"),
    `${JSON.stringify(credentials)}\n`,
    { mode: 0o600 }
  );
}

test("远程管理 CLI 凭据绑定签发服务地址，跨环境令牌不外发", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-remote-admin-creds-"));
  const databasePath = join(directory, "server.sqlite");
  const adminBootstrap = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "media")
  });
  const adminToken =
    (await adminBootstrap.sessions.createDevelopmentSession("remote-admin")).token;
  adminBootstrap.close();

  const credentialsDirectory = mkdtempSync(
    join(tmpdir(), "kangmin-remote-admin-cli-home-")
  );
  const server = await startServer(databasePath);
  try {
    // 凭据记录的是另一个服务地址：令牌绝不发送给当前服务。
    writeAdminCredentials(credentialsDirectory, {
      token: adminToken,
      username: "remote-admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
      baseUrl: "https://other.example.test"
    });
    const mismatched = await runAdminCliWithCredentials(
      ["auth", "status", "--json"],
      server.origin,
      credentialsDirectory
    );
    // auth status 未认证时返回 loggedIn=false 而非错误；
    // 若错发有效令牌，这里会变成 loggedIn=true。
    assert.equal(mismatched.status, 0, mismatched.stderr || mismatched.stdout);
    assert.equal(
      (JSON.parse(mismatched.stdout) as { data: { loggedIn: boolean } }).data.loggedIn,
      false
    );

    // 本地模式签发的凭据（无 baseUrl）同样不能用于远程服务。
    writeAdminCredentials(credentialsDirectory, {
      token: adminToken,
      username: "remote-admin",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const localCredentials = await runAdminCliWithCredentials(
      ["auth", "status", "--json"],
      server.origin,
      credentialsDirectory
    );
    assert.equal(localCredentials.status, 0, localCredentials.stderr || localCredentials.stdout);
    assert.equal(
      (JSON.parse(localCredentials.stdout) as { data: { loggedIn: boolean } }).data.loggedIn,
      false
    );

    // baseUrl 精确一致时凭据生效。
    writeAdminCredentials(credentialsDirectory, {
      token: adminToken,
      username: "remote-admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
      baseUrl: server.origin
    });
    const matched = await runAdminCliWithCredentials(
      ["auth", "status", "--json"],
      server.origin,
      credentialsDirectory
    );
    assert.equal(matched.status, 0, matched.stderr || matched.stdout);
    assert.equal(
      (JSON.parse(matched.stdout) as { data: { loggedIn: boolean } }).data.loggedIn,
      true
    );

    // 显式环境变量令牌优先于凭据文件，不受绑定限制。
    writeAdminCredentials(credentialsDirectory, {
      token: "bogus-token",
      username: "remote-admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
      baseUrl: "https://other.example.test"
    });
    const envOverride = await runAdminCliWithCredentials(
      ["auth", "status", "--json"],
      server.origin,
      credentialsDirectory,
      { KANGMIN_ADMIN_TOKEN: adminToken }
    );
    assert.equal(envOverride.status, 0, envOverride.stderr || envOverride.stdout);
  } finally {
    if (server.server.listening) {
      await stopServer(server);
    }
  }
});
