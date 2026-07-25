import { searchPublishedKnowledge } from "@/lib/admin/knowledge-index";
import { jsonError, runtime } from "@/lib/admin/store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().slice(0, 200) || "";
    if (!query) return jsonError("请输入检索内容");
    const requestedLimit = Number(url.searchParams.get("limit") || 5);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 10) : 5;
    const result = await searchPublishedKnowledge(await runtime(), query, limit);
    return Response.json({ query, ...result });
  } catch {
    return jsonError("知识检索服务暂不可用", 503);
  }
}
