import { createAgentApi } from "@/lib/agent/api";
import { findApprovedPlan } from "@/lib/agent/approved-plans";
import { createRuntimeHealthIdentityResolver } from "@/lib/health-records/identity";

const identityResolver = createRuntimeHealthIdentityResolver();
const api = createAgentApi({
  approvedPlanProvider: findApprovedPlan,
  approvedPlanAccess: async (request) => {
    if (request.headers.has("x-user-id")) return false;
    const identity = await identityResolver.resolve(request);
    // synthetic identity is limited to local/integration by the resolver; production
    // must use the server-signed verified-phone session before returning a formal plan.
    return identity?.assurance === "verified_phone" || identity?.assurance === "synthetic";
  },
});

export const POST = api.explain;
