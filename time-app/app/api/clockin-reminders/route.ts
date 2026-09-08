import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// POST { title, body } — publish a new clock-in reminder. There is no edit
// and no delete: published wording is what people sign for.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  let b: { title?: unknown; body?: unknown };
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const title = typeof b.title === "string" ? b.title.trim() : "";
  const message = typeof b.body === "string" ? b.body.trim() : "";
  if (!title || !message)
    return NextResponse.json({ error: "Title and message required" }, { status: 400 });
  if (title.length > 120)
    return NextResponse.json({ error: "Title is too long (120 characters max)." }, { status: 400 });
  if (message.length > 4000)
    return NextResponse.json({ error: "Message is too long (4000 characters max)." }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("clockin_reminders")
    .insert({ title, body: message, created_by: profile.id })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ reminder: data });
}
