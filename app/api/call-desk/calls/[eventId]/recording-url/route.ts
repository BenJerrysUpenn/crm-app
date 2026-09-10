import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const BUCKET = "call-recordings";

// Extensions a phone actually produces for a call recording. Anything else
// is rejected rather than guessed at — the path is built from this value.
const ALLOWED_EXT = ["m4a", "mp3", "mp4", "wav", "aac", "ogg", "webm", "caf"];

const ALLOWED_CONTENT_TYPE_PREFIXES = ["audio/", "video/"];

// POST /api/call-desk/calls/:eventId/recording-url
//   body: { consent_confirmed: true, ext, content_type }
//
// Mints a one-shot signed upload URL for a call recording.
//
// CONSENT GATE — this is the legal control, not a UI nicety. Pennsylvania is
// a two-party-consent state: recording a call without the other party's
// agreement is a crime, so the server refuses to mint an upload URL unless
// the caller asserts consent was obtained on the call. A client that skips
// the checkbox cannot get a URL by calling the API directly. The flag is
// persisted alongside the recording on the event's detail JSON by the
// follow-up PATCH.
export async function POST(
  request: Request,
  { params }: { params: { eventId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const eventId = Number(params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return NextResponse.json({ error: "Bad event id" }, { status: 400 });

  let body: {
    consent_confirmed?: unknown;
    ext?: unknown;
    content_type?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (body.consent_confirmed !== true)
    return NextResponse.json(
      {
        error:
          "Recording requires confirmed consent. Pennsylvania is a two-party-consent state: the caller must have told the other party the call was being recorded and they must have agreed.",
      },
      { status: 400 },
    );

  const ext =
    typeof body.ext === "string" ? body.ext.trim().toLowerCase().replace(/^\./, "") : "";
  if (!ALLOWED_EXT.includes(ext))
    return NextResponse.json(
      { error: `ext must be one of ${ALLOWED_EXT.join(", ")}` },
      { status: 400 },
    );

  const contentType =
    typeof body.content_type === "string" ? body.content_type.trim() : "";
  if (
    !contentType ||
    contentType.length > 128 ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
    !ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => contentType.startsWith(p))
  )
    return NextResponse.json(
      { error: "content_type must be an audio/* or video/* MIME type" },
      { status: 400 },
    );

  // The path is keyed by prospect, so read it off the call row rather than
  // trusting anything from the client.
  const { data: row, error: readErr } = await supabase
    .from("outreach_events")
    .select("id, prospect_id, event")
    .eq("id", eventId)
    .maybeSingle();
  if (readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  if (row.event !== "called")
    return NextResponse.json(
      { error: `Event ${eventId} is '${row.event}', not a call` },
      { status: 409 },
    );

  const path = `${row.prospect_id}/${eventId}-${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data)
    return NextResponse.json(
      { error: error?.message ?? "Could not create an upload URL" },
      { status: 500 },
    );

  return NextResponse.json({ path: data.path, token: data.token });
}
