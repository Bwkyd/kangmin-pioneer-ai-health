import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("用户端和智能体必须带出已审核方案的步骤与风险边界", async () => {
  const publicRoute = await readFile(new URL("../../../app/api/content/route.ts", import.meta.url), "utf8");
  const agentProvider = await readFile(new URL("../../../lib/agent/approved-plans.ts", import.meta.url), "utf8");
  assert.match(publicRoute, /plan_steps/);
  assert.match(publicRoute, /risks/);
  assert.match(publicRoute, /contraindications/);
  assert.match(agentProvider, /risks/);
  assert.match(agentProvider, /contraindications/);
  assert.match(agentProvider, /steps\.results\.length === 0/);
});

test("方案步骤视频只允许通过当前已审核的发布方案播放", async () => {
  const mediaRoute = await readFile(new URL("../../../app/api/media/[id]/route.ts", import.meta.url), "utf8");
  assert.match(mediaRoute, /plan_steps/);
  assert.match(mediaRoute, /planLinksSafe/);
  assert.match(mediaRoute, /content_version = plan\.version/);
});
