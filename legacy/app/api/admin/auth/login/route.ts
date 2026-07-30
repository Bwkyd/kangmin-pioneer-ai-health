import { ADMIN_COOKIE, adminCookieOptions, createAdminSession, verifyAdminPassword } from "@/lib/admin/auth";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?: string; password?: string };
    if (!body.username || !body.password || !(await verifyAdminPassword(body.username, body.password))) {
      return Response.json({ error: "账号或密码错误" }, { status: 401 });
    }
    const cookieStore = await cookies();
    cookieStore.set(ADMIN_COOKIE, await createAdminSession(body.username), {
      ...adminCookieOptions,
      secure: new URL(request.url).protocol === "https:",
    });
    return Response.json({ username: body.username });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_AUTH_NOT_CONFIGURED") {
      return Response.json({ error: "管理员登录尚未配置" }, { status: 503 });
    }
    return Response.json({ error: "登录请求无效" }, { status: 400 });
  }
}
