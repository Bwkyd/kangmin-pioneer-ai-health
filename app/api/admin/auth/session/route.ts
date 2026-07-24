import { requireAdmin } from "@/lib/admin/auth";

export async function GET() {
  try {
    const session = await requireAdmin();
    return Response.json({ authenticated: true, username: session.username });
  } catch {
    return Response.json({ authenticated: false }, { status: 401 });
  }
}
