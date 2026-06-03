"use client";

export default function SearchBar({
  value,
  onChange,
  placeholder = "Search...",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative flex-1 max-w-md">
      <svg
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
      >
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M9.5 9.5L12 12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-8 py-1.5 text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded-md placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-500"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm"
        >
          ×
        </button>
      )}
    </div>
  );
}
