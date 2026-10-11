"use client";

// The change-category dialog on /money (bj-finance #223). Saves one
// correction — "every charge from this merchant" (the default) or "just this
// one" — through POST /api/pf/overrides. The page shows the new category at
// once; the totals follow at the next 08:00 bookkeeping pass.

import { useEffect, useId, useRef, useState } from "react";
import type { OverrideScope, PfOverride } from "@/lib/pf/overrides";
import type { ExplorerRow } from "@/lib/pf/types";

const fmt2 = (n: number) =>
  (n < 0 ? "−" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export default function ChangeCategory({
  row,
  categories,
  onClose,
  onSaved,
}: {
  row: ExplorerRow;
  categories: string[];
  onClose: () => void;
  onSaved: (o: PfOverride) => void;
}) {
  const [category, setCategory] = useState(
    row.c && categories.includes(row.c) ? row.c : "",
  );
  const [scope, setScope] = useState<OverrideScope>("merchant");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const titleId = useId();

  useEffect(() => {
    selectRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!category || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pf/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          txn_id: row.id,
          merchant: row.m,
          category,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Could not save (${res.status})`);
        setSaving(false);
        return;
      }
      onSaved(body.override as PfOverride);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setSaving(false);
    }
  }

  return (
    <div className="pf-dialog-backdrop" onClick={onClose}>
      <form
        className="pf-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
      >
        <h2 id={titleId}>Change category</h2>
        <p className="pf-dialog-what">
          <b>{row.m}</b>
          <span>
            {row.d} · {fmt2(row.a)}
          </span>
        </p>

        <label className="pf-field">
          <span>Category</span>
          <select
            ref={selectRef}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
          >
            {!category && <option value="">Choose a category</option>}
            {categories.map((c) => (
              <option key={c} value={c}>
                {c.trim()}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="pf-field">
          <legend>Apply to</legend>
          <label className="pf-choice">
            <input
              type="radio"
              name="scope"
              value="merchant"
              checked={scope === "merchant"}
              onChange={() => setScope("merchant")}
            />
            <span>Every charge from {row.m}</span>
          </label>
          <label className="pf-choice">
            <input
              type="radio"
              name="scope"
              value="transaction"
              checked={scope === "transaction"}
              onChange={() => setScope("transaction")}
            />
            <span>Just this one</span>
          </label>
        </fieldset>

        <p className="pf-dialog-note">
          The new category shows here right away. Totals update after the next
          8:00 AM bookkeeping pass
          {scope === "merchant" ? ", which also turns this into a rule" : ""}.
        </p>

        {error && (
          <p className="pf-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="pf-dialog-actions">
          <button type="button" className="pf-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="pf-btn primary"
            disabled={!category || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
