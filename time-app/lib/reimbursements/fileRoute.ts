// Opening an uploaded Receipt, Lyft ride report or Adjustment evidence: a
// redirect to a five-minute signed URL, signed with the caller's own session so
// the bucket's policies decide (migration 37): staff their own folder,
// Approvers everything. Served at /api/reimbursements/file (time site) and
// /api/payroll/reimbursements/file (finance site, Approvers only).

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { BUCKET } from "./server";

export async function signedFileRedirect(request: Request): Promise<NextResponse> {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!path || path.includes("..")) return NextResponse.json({ error: "Bad path" }, { status: 400 });
  const { data, error } = await createClient().storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
