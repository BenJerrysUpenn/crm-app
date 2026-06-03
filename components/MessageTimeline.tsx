"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ThreadMessage } from "@/lib/types";
import { fmtEasternDateTime } from "@/lib/dateFormat";

function senderShort(s: string | null): string {
  if (!s) return "";
  // Extract just the local part if it's an email, otherwise return as is.
  const at = s.indexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

function MessageBubble({
  msg,
  prevSubject,
}: {
  msg: ThreadMessage;
  prevSubject: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const outbound = msg.direction === "outbound";
  const align = outbound ? "items-end" : "items-start";
  const bubbleColour = outbound
    ? "bg-emerald-500/15 border-emerald-500/30 text-slate-100"
    : "bg-slate-800 border-slate-700 text-slate-100";
  const hasBody = (msg.body_full || msg.body || "").trim() !== "";
  const previewBody = (msg.body || msg.body_full || "").trim();
  const fullBody = (msg.body_full || msg.body || "").trim();
  const showSubject =
    msg.subject && msg.subject.trim() !== "" && msg.subject !== prevSubject;

  return (
    <div className={`flex flex-col ${align} gap-1 max-w-full`}>
      <div className="flex items-baseline gap-2 text-[11px] text-slate-500">
        <span>{senderShort(msg.sender)}</span>
        {msg.sent_at && <span>·</span>}
        {msg.sent_at && <span>{fmtEasternDateTime(msg.sent_at)}</span>}
      </div>
      <div
        className={`max-w-[85%] border rounded-lg px-3 py-2 ${bubbleColour} shadow-sm`}
      >
        {showSubject && (
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
            {msg.subject}
          </div>
        )}
        {hasBody && (
          <div
            className={`text-sm whitespace-pre-wrap leading-snug ${
              expanded ? "" : "line-clamp-3"
            }`}
          >
            {expanded ? fullBody : previewBody}
          </div>
        )}
        {hasBody && fullBody !== previewBody && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[11px] text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline"
          >
            {expanded ? "show snippet" : "show full message"}
          </button>
        )}
        {hasBody && fullBody === previewBody && fullBody.length > 240 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[11px] text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline"
          >
            {expanded ? "collapse" : "expand"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function MessageTimeline({ dealId }: { dealId: number }) {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    supabase
      .from("thread_messages")
      .select("*")
      .eq("deal_id", dealId)
      .order("sent_at", { ascending: true, nullsFirst: true })
      .then(({ data, error }) => {
        if (!active) return;
        setLoading(false);
        if (error) {
          setError(error.message);
          return;
        }
        setMessages((data ?? []) as ThreadMessage[]);
      });
    return () => {
      active = false;
    };
  }, [supabase, dealId]);

  // Scroll to bottom (latest) when messages load.
  useEffect(() => {
    if (!loading && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [loading, messages.length]);

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-500 italic">Loading messages...</div>
    );
  }
  if (error) {
    return <div className="p-6 text-sm text-rose-300">{error}</div>;
  }
  if (messages.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500 italic">
        No messages stored for this deal yet. The catering sweep ingests new
        thread messages on each run; check back after the next pass.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {messages.map((m, idx) => {
        const prev = messages[idx - 1];
        const prevSubject = prev?.subject ?? null;
        return (
          <MessageBubble
            key={m.id ?? `${m.gmail_message_id}-${idx}`}
            msg={m}
            prevSubject={prevSubject}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
