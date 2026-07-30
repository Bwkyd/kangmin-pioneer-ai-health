import { requireAdmin } from "@/lib/admin/auth";
import { DocumentImportError, parseArticleImport } from "@/lib/admin/document-import";
import { jsonError } from "@/lib/admin/store";

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError("请选择 Word 或 PDF 文件");
    return Response.json(await parseArticleImport(file));
  } catch (error) {
    if (error instanceof DocumentImportError) return jsonError(error.message, error.status);
    if (error instanceof Error && error.message === "ADMIN_UNAUTHORIZED") return jsonError("未授权", 401);
    return jsonError("文章文件转换失败，请稍后重试", 503);
  }
}
