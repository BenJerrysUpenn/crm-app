// Opening an uploaded Receipt, Lyft ride report or Adjustment evidence: a
// redirect to a five-minute signed URL, signed with the caller's own session so
// the bucket's policies decide (migration 37): staff their own folder,
// Approvers everything. Served at /api/reimbursements/file (time site) and
// /api/payroll/reimbursements/file (finance site, Approvers only).

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { BUCKET } from "./submission";

/**
 * A one-shot signed upload to `path`, made with the caller's own session so
 * the bucket's policies decide: { path, token } for the browser's
 * uploadToSignedUrl. Served by /api/reimbursements/upload-url (staff) and
 * /api/payroll/reimbursements/evidence-url (Approvers).
 */
export async function signedUploadResponse(path: string): Promise<NextResponse> {
  const { data, error } = await createClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not create an upload URL" }, { status: 500 });
  return NextResponse.json({ path: data.path, token: data.token });
}

export async function signedFileRedirect(request: Request): Promise<NextResponse> {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!path || path.includes("..")) return NextResponse.json({ error: "Bad path" }, { status: 400 });
  const { data, error } = await createClient().storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
