import { getProfile } from "@/lib/auth";
import { signedFileRedirect } from "@/lib/reimbursements/fileRoute";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/reimbursements/file?path=
// Opens one of the staff member's own uploads (lib/reimbursements/fileRoute.ts).
export async function GET(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return signedFileRedirect(request);
}
