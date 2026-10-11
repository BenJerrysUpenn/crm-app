"use client";

import type { ReactNode } from "react";

/**
 * A dismissable dialog: a dimmed backdrop that closes on click, around a panel
 * that caps its height at the screen and scrolls inside (`.modal-panel`).
 * `className` carries what differs between dialogs — width and spacing.
 */
export default function Modal({
  onClose,
  className,
  children,
}: {
  onClose: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={onClose}>
      <div
        className={`bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 modal-panel rounded-xl p-5 w-full ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
