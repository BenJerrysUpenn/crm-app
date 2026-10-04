// PROTOTYPE (v6) — the "Recipient pages" previews on /email-campaigns.
//
// Shows a recipient-facing HTML page inside sandboxed iframes (srcDoc). The
// empty `sandbox` attribute blocks forms and scripts, so pressing a button in
// the preview posts nothing and writes nothing.

import Link from "next/link";

export type Frame = { label: string; caption: string; html: string };

export default function RecipientPageFrames({
  title,
  intro,
  frames,
}: {
  title: string;
  intro: React.ReactNode;
  frames: Frame[];
}) {
  return (
    <div className="min-h-screen bg-slate-950 px-3 py-4 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/email-campaigns" className="text-xs text-slate-400 hover:text-slate-200">
            ← Email campaigns
          </Link>
          <span className="text-slate-700">/</span>
          <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
          <span className="rounded border border-fuchsia-600 bg-fuchsia-600/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-300">
            Prototype preview
          </span>
        </div>
        <div className="space-y-1.5 rounded border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
          {intro}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {frames.map((f) => (
            <figure key={f.label} className="space-y-1.5">
              <figcaption className="text-xs text-slate-400">
                <span className="font-medium text-slate-200">{f.label}</span> · {f.caption}
              </figcaption>
              <iframe
                title={f.label}
                srcDoc={f.html}
                sandbox=""
                className="h-[640px] w-full rounded-md border border-slate-700 bg-[#0f172a]"
              />
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
