"use client";

import type { ReactNode } from "react";

export function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-800 text-sm items-start">
      <div className="text-slate-500 col-span-1 pt-1.5">{label}</div>
      <div className="col-span-2">{children}</div>
    </div>
  );
}

const inputCls =
  "w-full text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1.5 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500";

export function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "email" | "tel" | "date" | "time";
  placeholder?: string;
  step?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      className={inputCls}
    />
  );
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className={inputCls + " resize-y"}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ label: string; value: string } | string>;
  placeholder?: string;
}) {
  const optionValues = options.map((o) => (typeof o === "string" ? o : o.value));
  const valueIsKnown = value === "" || optionValues.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {/* Preserve any unknown current value so it doesn't silently disappear
          when the deal has a legacy package name we don't list. */}
      {!valueIsKnown && (
        <option value={value}>{value} (legacy)</option>
      )}
      {options.map((opt) => {
        const v = typeof opt === "string" ? opt : opt.value;
        const l = typeof opt === "string" ? opt : opt.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

export function ToggleYesNo({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="inline-flex rounded-md overflow-hidden border border-slate-700">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`px-3 py-1 text-xs font-medium ${
          value
            ? "bg-emerald-500/20 text-emerald-300"
            : "bg-slate-800 text-slate-400 hover:bg-slate-700"
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`px-3 py-1 text-xs font-medium border-l border-slate-700 ${
          !value
            ? "bg-rose-500/20 text-rose-300"
            : "bg-slate-800 text-slate-400 hover:bg-slate-700"
        }`}
      >
        No
      </button>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-200 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-slate-400 w-4 h-4"
      />
      {label && <span>{label}</span>}
    </label>
  );
}
