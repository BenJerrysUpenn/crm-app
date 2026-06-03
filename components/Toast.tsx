"use client";

import { useEffect } from "react";

export default function Toast({
  message,
  kind,
  onDismiss,
}: {
  message: string;
  kind: "error" | "info";
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 max-w-sm shadow-lg rounded-md px-4 py-3 text-sm border ${
        kind === "error"
          ? "bg-rose-950 text-rose-200 border-rose-900"
          : "bg-zinc-800 text-zinc-100 border-zinc-700"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">{message}</div>
        <button
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100 leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
