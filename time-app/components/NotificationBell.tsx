"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtDateTime } from "@/lib/format";
import type { Notification } from "@/lib/types";

export default function NotificationBell() {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    setItems((data as Notification[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const unread = items.filter((i) => !i.read_at).length;

  async function markAll() {
    const ids = items.filter((i) => !i.read_at).map((i) => i.id);
    if (ids.length === 0) return;
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", ids);
    load();
  }

  async function clearAll() {
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return;
    await supabase.from("notifications").delete().in("id", ids);
    setItems([]);
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markAll();
        }}
        className="relative text-slate-300 hover:text-slate-100 p-1"
        aria-label="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-rose-500 text-white text-[10px] rounded-full h-4 min-w-4 px-1 flex items-center justify-center">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-30">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 sticky top-0 bg-slate-900">
            <span className="text-xs font-medium text-slate-400">Notifications</span>
            {items.length > 0 && (
              <button onClick={clearAll} className="text-xs text-slate-400 hover:text-rose-400">
                Clear all
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No notifications.</div>
          ) : (
            items.map((n) => (
              <div key={n.id} className="px-3 py-2 border-b border-slate-800 last:border-0">
                <div className="text-sm text-slate-200">{n.title}</div>
                {n.body && <div className="text-xs text-slate-400 mt-0.5">{n.body}</div>}
                <div className="text-[10px] text-slate-600 mt-1">{fmtDateTime(n.created_at)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
