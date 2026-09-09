"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const BUCKET = "call-recordings";
const ALLOWED_EXT = ["m4a", "mp3", "mp4", "wav", "aac", "ogg", "webm", "caf"];

function extOf(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ALLOWED_EXT.includes(fromName)) return fromName;
  // Fall back to the browser's MIME guess: "audio/mp4" -> "mp4".
  const sub = (file.type.split("/")[1] ?? "").split(";")[0].toLowerCase();
  if (ALLOWED_EXT.includes(sub)) return sub;
  if (sub === "x-m4a" || sub === "mpeg") return sub === "mpeg" ? "mp3" : "m4a";
  return "";
}

/**
 * Attach a recording to a logged call.
 *
 * Default practice is NOT to record, so this sits collapsed behind a small
 * disclosure. Pennsylvania is a two-party-consent state: the file input and
 * the Upload button do not exist until the caller confirms the other party
 * was told and agreed. The server enforces the same rule independently —
 * /recording-url returns 400 without consent_confirmed — so ticking the box
 * in devtools buys nothing.
 */
export default function RecordingUploader({
  eventId,
  onUploaded,
}: {
  eventId: number | null;
  onUploaded: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file || busy) return;
    if (!eventId) {
      setError("Log a call for this prospect first.");
      return;
    }

    const ext = extOf(file);
    if (!ext) {
      setError(
        `Unsupported file type. Use one of: ${ALLOWED_EXT.join(", ")}.`,
      );
      return;
    }

    setBusy(true);
    setError(null);
    setStatus("Requesting an upload slot…");

    try {
      const res = await fetch(
        `/api/call-desk/calls/${eventId}/recording-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            consent_confirmed: true,
            ext,
            content_type: file.type || `audio/${ext}`,
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Upload URL refused (${res.status})`);
      }
      const { path, token } = (await res.json()) as {
        path: string;
        token: string;
      };

      setStatus("Uploading…");
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .uploadToSignedUrl(path, token, file, {
          contentType: file.type || undefined,
        });
      if (upErr) throw new Error(upErr.message);

      setStatus("Saving…");
      const patch = await fetch(`/api/call-desk/calls/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recording_path: path,
          consent_confirmed: true,
        }),
      });
      if (!patch.ok) {
        const payload = await patch.json().catch(() => ({}));
        throw new Error(
          payload.error ||
            `Uploaded, but linking it to the call failed (${patch.status})`,
        );
      }

      setStatus("Recording attached.");
      if (fileRef.current) fileRef.current.value = "";
      onUploaded(path);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="min-h-[44px] text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2"
      >
        {open ? "Hide recording upload" : "Attach recording"}
      </button>

      {open && (
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-950 px-3 py-3">
          <p className="text-xs text-slate-500 mb-2">
            Default practice is not to record. Pennsylvania needs both
            parties&apos; consent.
          </p>

          <label className="flex items-start gap-3 text-xs text-slate-300 min-h-[44px] py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-emerald-500 shrink-0"
            />
            <span>
              I told them the call was being recorded and they agreed.
            </span>
          </label>

          {consent && (
            <div className="mt-3 space-y-2">
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,video/*"
                className="block w-full text-xs text-slate-400 file:mr-3 file:min-h-[36px] file:rounded file:border file:border-slate-700 file:bg-slate-800 file:px-3 file:text-xs file:text-slate-200"
              />
              <button
                type="button"
                onClick={upload}
                disabled={busy}
                className="w-full min-h-[44px] text-sm bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-md border border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? "Working…" : "Upload recording"}
              </button>
            </div>
          )}

          {!eventId && (
            <p className="mt-2 text-xs text-amber-300">
              No call logged for this prospect yet — tap Call now first.
            </p>
          )}
          {status && <p className="mt-2 text-xs text-emerald-300">{status}</p>}
          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
        </div>
      )}
    </div>
  );
}
