import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteCommandClient } from "@kangmin/runtime/remote-command-composition-root";
import { RemoteCommandClient } from "@kangmin/integrations/operations/remote-command-client";
import { DomainError } from "@kangmin/core/kernel/errors";
import { success } from "@kangmin/core/kernel/result";

const meta = {
  service: "kangmin-command-service",
  serviceVersion: "0.1.0",
  protocolVersion: "1",
  schemaVersion: "1",
  audiences: ["patient", "admin"]
};

test("远程客户端先校验协议，再发送版本化患者命令", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const expected = success("browse", { items: [] }, "remote-request");
  const client = new RemoteCommandClient({
    baseUrl: "https://api.example.test/root",
    audience: "patient",
    token: "patient-token",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? Response.json(meta)
        : Response.json(expected);
    }
  });

  const result = await client.execute({
    command: "browse",
    requestId: "remote-request"
  });
  assert.deepEqual(result, expected);
  assert.equal(calls[0]?.url, "https://api.example.test/root/v1/meta");
  assert.equal(
    calls[1]?.url,
    "https://api.example.test/root/v1/patient/commands"
  );
  assert.equal(
    (calls[1]?.init.headers as Record<string, string>).authorization,
    "Bearer patient-token"
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    schemaVersion: "1",
    command: "browse",
    input: {},
    requestId: "remote-request"
  });
});

test("远程客户端对地址、协议、非 JSON 与网络故障 fail closed", async () => {
  assert.throws(
    () => new RemoteCommandClient({
      baseUrl: "https://user:secret@example.test/path?x=1",
      audience: "admin"
    }),
    (error) => error instanceof DomainError && error.code === "config_missing"
  );

  const incompatible = new RemoteCommandClient({
    baseUrl: "https://api.example.test",
    audience: "patient",
    fetchImpl: async () => Response.json({ ...meta, protocolVersion: "2" })
  });
  await assert.rejects(
    () => incompatible.execute({ command: "browse" }),
    (error) => error instanceof DomainError && error.code === "protocol_incompatible"
  );

  const nonJson = new RemoteCommandClient({
    baseUrl: "https://api.example.test",
    audience: "patient",
    fetchImpl: async () => new Response("not-json")
  });
  await assert.rejects(
    () => nonJson.execute({ command: "browse" }),
    (error) => error instanceof DomainError && error.code === "protocol_incompatible"
  );

  let correlationCalls = 0;
  const mismatched = new RemoteCommandClient({
    baseUrl: "https://api.example.test",
    audience: "patient",
    fetchImpl: async () => {
      correlationCalls += 1;
      return correlationCalls === 1
        ? Response.json(meta)
        : Response.json(success("browse", {}, "different-request"));
    }
  });
  await assert.rejects(
    () => mismatched.execute({ command: "browse", requestId: "expected-request" }),
    (error) => error instanceof DomainError && error.code === "protocol_incompatible"
  );

  const unavailable = new RemoteCommandClient({
    baseUrl: "https://api.example.test",
    audience: "patient",
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  await assert.rejects(
    () => unavailable.execute({ command: "browse" }),
    (error) =>
      error instanceof DomainError &&
      error.code === "service_unavailable" &&
      error.retryable
  );
});

test("staging/production 的远程地址强制 HTTPS，local/integration 允许 http", () => {
  for (const appEnvironment of ["staging", "production"]) {
    assert.throws(
      () =>
        createRemoteCommandClient(
          {
            KANGMIN_API_BASE_URL: "http://api.example.test",
            KANGMIN_APP_ENV: appEnvironment
          },
          "admin",
          "token"
        ),
      (error) =>
        error instanceof DomainError && error.code === "config_missing"
    );
  }

  const productionHttps = createRemoteCommandClient(
    {
      KANGMIN_API_BASE_URL: "https://api.example.test",
      KANGMIN_APP_ENV: "production"
    },
    "patient",
    "token"
  );
  assert.ok(productionHttps instanceof RemoteCommandClient);

  for (const appEnvironment of ["local", "integration", undefined]) {
    const client = createRemoteCommandClient(
      {
        KANGMIN_API_BASE_URL: "http://127.0.0.1:8787",
        ...(appEnvironment === undefined
          ? {}
          : { KANGMIN_APP_ENV: appEnvironment })
      },
      "patient",
      "token"
    );
    assert.ok(client instanceof RemoteCommandClient);
  }
});
