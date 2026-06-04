"use client";

import { useEffect, useRef, useState } from "react";

export default function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  renderOption,
  quantityMode = false,
  defaultQuantityFor,
}: {
  options: ReadonlyArray<string>;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  renderOption?: (opt: string) => React.ReactNode;
  // When true: every option behaves as quantity-tracked. Storage stays
  // as a flat list of repeated names — the catering quote module already
  // iterates per occurrence. Chip renders as "Name [qty] ×" with the
  // qty as a typeable number input.
  quantityMode?: boolean;
  // (quantityMode only) Returns the default qty to insert when a fresh
  // option is added from the dropdown. Defaults to 1.
  defaultQuantityFor?: (option: string) => number;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  function clickOption(opt: string) {
    if (quantityMode) {
      const existingCount = value.filter((v) => v === opt).length;
      if (existingCount > 0) {
        // Already in the chip list — clicking the dropdown row again is
        // a no-op (use the chip's input to change qty).
        return;
      }
      const defaultQty = defaultQuantityFor ? defaultQuantityFor(opt) : 1;
      const additions = Array(Math.max(1, defaultQty)).fill(opt);
      onChange([...value, ...additions]);
      return;
    }
    if (value.includes(opt)) {
      onChange(value.filter((v) => v !== opt));
    } else {
      onChange([...value, opt]);
    }
  }

  function setQuantityFor(opt: string, qty: number) {
    const clean = Math.max(0, Math.floor(qty));
    const others = value.filter((v) => v !== opt);
    if (clean === 0) {
      onChange(others);
      return;
    }
    onChange([...others, ...Array(clean).fill(opt)]);
  }

  function removeAllOf(opt: string) {
    onChange(value.filter((v) => v !== opt));
  }

  function removeAtIndex(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  // Count occurrences for the dropdown indicator and the chips.
  const countByOption = new Map<string, number>();
  for (const v of value) {
    countByOption.set(v, (countByOption.get(v) ?? 0) + 1);
  }

  const filtered = filter
    ? options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()))
    : options;

  const uniqueValues = quantityMode
    ? Array.from(new Set(value))
    : null;

  return (
    <div className="relative" ref={ref}>
      <div
        className="w-full text-left text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1.5 hover:border-slate-600 min-h-[32px] cursor-text"
        onClick={() => setOpen(true)}
      >
        {value.length === 0 ? (
          <span className="text-slate-500">{placeholder}</span>
        ) : quantityMode && uniqueValues ? (
          <div className="flex flex-col gap-1">
            {uniqueValues.map((v) => {
              const qty = countByOption.get(v) ?? 0;
              return (
                <div
                  key={v}
                  className="flex items-center gap-2 bg-slate-700 text-slate-100 text-xs rounded px-2 py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="flex-1 truncate">{v}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={qty}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setQuantityFor(v, Number.isFinite(n) ? n : 0);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-14 bg-slate-800 border border-slate-600 text-slate-100 rounded px-1.5 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-slate-400"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAllOf(v);
                    }}
                    title="Remove"
                    className="text-slate-400 hover:text-rose-300 cursor-pointer text-base leading-none"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="text-[10px] text-slate-500 mt-0.5 italic">
              Click to add another extra…
            </div>
          </div>
        ) : (
          <span className="flex flex-wrap gap-1">
            {value.map((v, i) => (
              <span
                key={`${v}-${i}`}
                className="inline-flex items-center gap-1 bg-slate-700 text-slate-100 text-[11px] rounded px-1.5 py-0.5"
              >
                {v}
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAtIndex(i);
                  }}
                  className="text-slate-400 hover:text-slate-100 cursor-pointer"
                >
                  ×
                </span>
              </span>
            ))}
          </span>
        )}
      </div>
      {open && (
        <div className="absolute left-0 right-0 mt-1 z-30 bg-slate-900 border border-slate-700 rounded-md shadow-xl max-h-72 overflow-hidden flex flex-col">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            className="text-sm bg-slate-800 border-b border-slate-700 text-slate-100 px-2 py-1.5 focus:outline-none"
          />
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-500 italic">
                No matches
              </div>
            ) : (
              filtered.map((opt) => {
                const count = countByOption.get(opt) ?? 0;
                const already = count > 0;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => clickOption(opt)}
                    disabled={quantityMode && already}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm text-slate-100 ${
                      quantityMode && already
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:bg-slate-800"
                    }`}
                  >
                    {quantityMode ? (
                      <span className="w-6 text-center text-slate-400 text-[11px]">
                        {already ? `×${count}` : "+"}
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={count > 0}
                        readOnly
                        className="accent-slate-400"
                      />
                    )}
                    {renderOption ? renderOption(opt) : <span>{opt}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
