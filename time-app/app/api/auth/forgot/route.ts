import { NextResponse } from "next/server";
import { sendPasswordReset, siteOrigin } from "@/lib/authLinks";

// POST /api/auth/forgot  { email }
// Public. Always answers 200 so it can't be used to probe which emails exist.
export async function POST(request: Request) {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@"))
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });

  await sendPasswordReset({ email, origin: siteOrigin(request) });
  return NextResponse.json({ ok: true });
}
