import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { BUCKET, uploadPath } from "@/lib/reimbursements/submission";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/reimbursements/upload-url   Body: { kind: "receipts" | "lyft", ext, content_type }
// A one-shot signed upload into the staff member's own folder of the private
// travel-reimbursements bucket (ADR 0002): a Receipt, or a Lyft ride report
// screenshot. The path is made here. The browser uploads with
// uploadToSignedUrl, then sends the path with the form.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { kind?: unknown; ext?: unknown; content_type?: unknown } | null;
  const kind = body?.kind === "lyft" ? "lyft" : body?.kind === "receipts" ? "receipts" : null;
  if (!kind) return NextResponse.json({ error: "kind must be receipts or lyft" }, { status: 400 });
  const path = uploadPath({ folder: me.id, kind, ext: body?.ext, content_type: body?.content_type });
  if (!path.ok) return NextResponse.json({ error: path.error }, { status: 400 });
  const { data, error } = await createClient().storage.from(BUCKET).createSignedUploadUrl(path.path);
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not create an upload URL" }, { status: 500 });
  return NextResponse.json({ path: data.path, token: data.token });
}
