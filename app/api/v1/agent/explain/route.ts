import { createAgentApi } from "@/lib/agent/api";
import { findApprovedPlan } from "@/lib/agent/approved-plans";

const api = createAgentApi({ approvedPlanProvider: findApprovedPlan });

export const POST = api.explain;
