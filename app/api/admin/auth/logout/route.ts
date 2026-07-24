import { ADMIN_COOKIE, adminCookieOptions } from "@/lib/admin/auth";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, "", { ...adminCookieOptions, secure: new URL(request.url).protocol === "https:", maxAge: 0 });
  return Response.json({ ok: true });
}
