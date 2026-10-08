"use client";

// The New / Edit form on the Reimbursements page (bj-finance #210).
//
//   Reason      Groceries / errands (with a "what for / where" note), or a
//               Catering Event picked from the last 365 days (date, start time,
//               venue/company, address; searchable).
//   Trip date   defaults to the Catering Event's date.
//   How         Personal car: Mileage (typed, or destinations with "Start
//               at the store" and "End at the store" each on by default),
//               optional tolls and parking, and Receipts. Lyft: Lyft ride
//               report screenshots only; Filed at once and nothing is paid back.
//   Files       each upload shows a preview (thumbnail, or PDF badge, with
//               name and size) before submitting (ruling 44).
//
// The server checks everything again and computes destination miles itself.

import { useEffect, useMemo, useState } from "react";
import { money } from "@/lib/payroll/paySheet";
import { centsFromDollars, milesFromInput, reimbursementCents, type MileageRate } from "@/lib/reimbursements/money";
import { placeLabel } from "@/lib/reimbursements/routeMiles";
import type { ReasonKind } from "@/lib/reimbursements/events";
import type { WithAmounts } from "@/lib/reimbursements/server";
import { CONTENT_TYPE_BY_EXT } from "@/lib/reimbursements/submission";
import { BUTTON, FilePreviews, INPUT, PRIMARY, uploadFile, type PickedFile } from "./shared";

type PickedEvent = { id: number; date: string; label: string; address: string | null };

const CONFIRM_NO_RECEIPT = "Are you sure there is no receipt?";

function centsText(cents: number): string {
  return cents ? (cents / 100).toFixed(2) : "";
}

/** A file already on the reimbursement being edited: only its path is known. */
function savedFile(path: string, i: number): PickedFile {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return { path, name: `Receipt ${i + 1} (uploaded before)`, size: null, type: CONTENT_TYPE_BY_EXT[ext] ?? "", url: `/api/reimbursements/file?path=${encodeURIComponent(path)}` };
}

export default function ReimbursementForm({
  rates,
  today,
  editing,
  onDone,
  onCancel,
}: {
  rates: MileageRate[];
  today: string;
  /** The reimbursement being edited or fixed; absent for New. */
  editing?: WithAmounts;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [reasonKind, setReasonKind] = useState<"" | ReasonKind>(editing?.reason_kind ?? "");
  const [event, setEvent] = useState<PickedEvent | null>(
    editing?.deal_id && editing.event_label
      ? { id: editing.deal_id, date: editing.event_date ?? editing.trip_date, label: editing.event_label, address: null }
      : null,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedEvent[] | null>(null);
  const [note, setNote] = useState(editing?.reason_note ?? "");
  const [tripDate, setTripDate] = useState(editing?.trip_date ?? today);
  const [how, setHow] = useState<"car" | "lyft">("car");
  const [mileageMode, setMileageMode] = useState<"typed" | "destinations">(editing?.mileage_mode ?? "typed");
  const [miles, setMiles] = useState(editing && editing.mileage_mode === "typed" ? String(Number(editing.miles)) : "");
  const [stops, setStops] = useState<string[]>(editing?.stops?.length ? editing.stops : [""]);
  const [startAtStore, setStartAtStore] = useState(editing?.start_at_store ?? true);
  const [endAtStore, setEndAtStore] = useState(editing?.end_at_store ?? true);
  const [route, setRoute] = useState<{ miles: number; legs: { from: string; to: string; miles: number }[] } | null>(
    editing?.route_legs ? { miles: Number(editing.miles), legs: editing.route_legs } : null,
  );
  const [tolls, setTolls] = useState(centsText(editing?.tolls_cents ?? 0));
  const [parking, setParking] = useState(centsText(editing?.parking_cents ?? 0));
  const [receiptFiles, setReceiptFiles] = useState<PickedFile[]>((editing?.receipt_paths ?? []).map(savedFile));
  const [shotFiles, setShotFiles] = useState<PickedFile[]>([]);
  const receipts = receiptFiles.map((f) => f.path);
  const shots = shotFiles.map((f) => f.path);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The Catering Event list: newest first, filtered as the staff member types.
  useEffect(() => {
    if (reasonKind !== "catering_event") return;
    let stale = false;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/reimbursements/events?q=${encodeURIComponent(query)}`);
      const payload = await res.json().catch(() => ({}));
      if (stale) return;
      const list: PickedEvent[] = res.ok ? payload.events : [];
      setResults(list);
      // Editing keeps only the Catering Event's id and label: take its venue
      // address from the list, so destinations mode can pre-fill it (ruling 46).
      setEvent((prev) => {
        const address = prev && prev.address == null ? list.find((e) => e.id === prev.id)?.address : null;
        return prev && address ? { ...prev, address } : prev;
      });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [reasonKind, query]);

  function pick(e: PickedEvent) {
    setEvent(e);
    setTripDate(e.date);
    // Destinations mode pre-fills the Catering Event's venue as a stop.
    if (e.address && stops.every((s) => !s.trim())) setStops([e.address]);
    setRoute(null);
  }

  const estimate = useMemo(() => {
    const m = mileageMode === "typed" ? milesFromInput(miles || "0") : route?.miles ?? null;
    const t = centsFromDollars(tolls);
    const p = centsFromDollars(parking);
    if (m == null || t == null || p == null) return null;
    return reimbursementCents({ trip_date: tripDate, miles: m, tolls_cents: t, parking_cents: p, mileage_cents_override: null }, rates);
  }, [mileageMode, miles, route, tolls, parking, tripDate, rates]);

  function reasonBody() {
    return reasonKind === "errands" ? { kind: "errands", note } : { kind: "catering_event", event_id: event?.id, note };
  }

  async function addFiles(files: FileList | null, kind: "receipts" | "lyft") {
    if (!files?.length) return;
    setErr(null);
    setBusy("Uploading…");
    try {
      const picked: PickedFile[] = [];
      for (const f of Array.from(files)) {
        const path = await uploadFile("/api/reimbursements/upload-url", { kind }, f);
        const ext = (f.name.split(".").pop() ?? "").toLowerCase();
        picked.push({ path, name: f.name, size: f.size, type: f.type || CONTENT_TYPE_BY_EXT[ext] || "", url: URL.createObjectURL(f) });
      }
      (kind === "receipts" ? setReceiptFiles : setShotFiles)((prev) => [...prev, ...picked]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function computeMiles() {
    setErr(null);
    setBusy("Computing miles…");
    const res = await fetch("/api/reimbursements/route-miles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stops, start_at_store: startAtStore, end_at_store: endAtStore }),
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setErr(payload.error || "Could not compute the miles.");
    setRoute({ miles: payload.miles, legs: payload.legs });
  }

  async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; payload: Record<string, unknown>; status: number }> {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, payload: await res.json().catch(() => ({})), status: res.status };
  }

  async function submit() {
    setErr(null);
    if (!reasonKind) return setErr("Pick a Reason.");
    if (reasonKind === "catering_event" && !event) return setErr("Pick the Catering Event.");

    if (how === "lyft") {
      setBusy("Filing…");
      const r = await send("/api/reimbursements/lyft", "POST", { reason: reasonBody(), trip_date: tripDate, screenshot_paths: shots });
      setBusy(null);
      if (!r.ok) return setErr(String(r.payload.error ?? "Could not file it."));
      return onDone(r.payload.emailed ? "Lyft ride report filed and sent to receipts@." : "Lyft ride report filed.");
    }

    const t = centsFromDollars(tolls) ?? 0;
    const p = centsFromDollars(parking) ?? 0;
    let confirmed = false;
    if ((t > 0 || p > 0) && receipts.length === 0) {
      if (!window.confirm(CONFIRM_NO_RECEIPT)) return;
      confirmed = true;
    }
    const body = {
      reason: reasonBody(),
      trip_date: tripDate,
      mileage: mileageMode === "typed" ? { mode: "typed", miles } : { mode: "destinations", stops, start_at_store: startAtStore, end_at_store: endAtStore },
      tolls,
      parking,
      receipt_paths: receipts,
      no_receipt_confirmed: confirmed,
    };
    setBusy(editing ? "Saving…" : "Submitting…");
    let r = await send(editing ? `/api/reimbursements/${editing.id}` : "/api/reimbursements", editing ? "PATCH" : "POST", body);
    if (!r.ok && r.payload.confirm === "no_receipt" && window.confirm(CONFIRM_NO_RECEIPT))
      r = await send(editing ? `/api/reimbursements/${editing.id}` : "/api/reimbursements", editing ? "PATCH" : "POST", { ...body, no_receipt_confirmed: true });
    setBusy(null);
    if (!r.ok) return setErr(String(r.payload.error ?? "Could not save it."));
    onDone(editing ? "Saved." : "Submitted. An Approver will decide it.");
  }

  const label = "block text-sm text-slate-700 dark:text-slate-300";
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {editing ? (editing.status === "rejected" ? "Fix and resubmit" : "Edit Travel Reimbursement") : "New"}
      </h2>

      <label className={label}>
        Reason
        <select
          value={reasonKind}
          onChange={(e) => setReasonKind(e.target.value as typeof reasonKind)}
          className={INPUT}
          required
        >
          <option value="">Choose…</option>
          <option value="errands">Groceries / errands</option>
          <option value="catering_event">A Catering Event</option>
        </select>
      </label>

      {reasonKind === "catering_event" && (
        <div className="space-y-2">
          {event && (
            <div className="text-sm rounded-md border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-slate-800 dark:text-slate-200">
              {event.label}
            </div>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search venue, company or address"
            className={INPUT}
          />
          <div className="max-h-56 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
            {results == null ? (
              <div className="px-3 py-2 text-sm text-slate-500">Loading…</div>
            ) : results.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-500">No Catering Events match.</div>
            ) : (
              results.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => pick(e)}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${
                    event?.id === e.id ? "font-medium text-slate-900 dark:text-slate-100" : "text-slate-700 dark:text-slate-300"
                  }`}
                >
                  {e.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {reasonKind && (
        <label className={label}>
          {reasonKind === "errands" ? "What for / where" : "Note (optional)"}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={INPUT} placeholder={reasonKind === "errands" ? "e.g. Restaurant Depot, cones" : ""} />
        </label>
      )}

      <label className={label}>
        Trip date
        <input type="date" value={tripDate} max={today} onChange={(e) => setTripDate(e.target.value)} className={INPUT} />
      </label>

      {!editing && (
        <fieldset className="space-y-1">
          <legend className="text-sm text-slate-700 dark:text-slate-300">How did you travel?</legend>
          <div className="flex gap-4 text-sm text-slate-800 dark:text-slate-200">
            <label className="flex items-center gap-2">
              <input type="radio" checked={how === "car"} onChange={() => setHow("car")} /> My own car
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={how === "lyft"} onChange={() => setHow("lyft")} /> Lyft (company card)
            </label>
          </div>
        </fieldset>
      )}

      {how === "lyft" ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Upload the Lyft ride report screenshot. Nothing is paid back: the ride was on the company card. It is filed and sent to receipts@ straight away.
          </p>
          <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => addFiles(e.target.files, "lyft")} className="text-sm" />
          <FilePreviews files={shotFiles} noun="Screenshot" onRemove={(p) => setShotFiles(shotFiles.filter((f) => f.path !== p))} />
        </div>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm text-slate-700 dark:text-slate-300">Mileage</legend>
            <div className="flex gap-4 text-sm text-slate-800 dark:text-slate-200">
              <label className="flex items-center gap-2">
                <input type="radio" checked={mileageMode === "typed"} onChange={() => setMileageMode("typed")} /> Type the miles
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mileageMode === "destinations"}
                  onChange={() => {
                    setMileageMode("destinations");
                    if (event?.address && stops.every((s) => !s.trim())) setStops([event.address]);
                  }}
                />{" "}
                Enter destinations
              </label>
            </div>
            {mileageMode === "typed" ? (
              <input inputMode="decimal" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="Miles, e.g. 12.3" className={INPUT} />
            ) : (
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
                  <input type="checkbox" checked={startAtStore} onChange={(e) => { setStartAtStore(e.target.checked); setRoute(null); }} /> Start at the store
                </label>
                {!startAtStore && (
                  <div className="text-xs text-slate-600 dark:text-slate-400">
                    The trip starts at the first stop. E.g. home → Restaurant Depot → store: enter Restaurant Depot first, and only Restaurant Depot → store is paid.
                  </div>
                )}
                {stops.map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={s}
                      onChange={(e) => {
                        setStops(stops.map((x, j) => (j === i ? e.target.value : x)));
                        setRoute(null);
                      }}
                      placeholder={i === 0 && !startAtStore ? "Stop 1 address (the trip starts here)" : `Stop ${i + 1} address`}
                      className={INPUT}
                    />
                    {stops.length > 1 && (
                      <button type="button" className={BUTTON} onClick={() => { setStops(stops.filter((_, j) => j !== i)); setRoute(null); }}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className={BUTTON} onClick={() => { setStops([...stops, ""]); setRoute(null); }}>
                    Add stop
                  </button>
                  <label className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
                    <input type="checkbox" checked={endAtStore} onChange={(e) => { setEndAtStore(e.target.checked); setRoute(null); }} /> End at the store
                  </label>
                  <button type="button" className={BUTTON} onClick={computeMiles} disabled={!!busy}>
                    Compute miles
                  </button>
                </div>
                {route && (
                  <div className="text-slate-700 dark:text-slate-300">
                    {route.legs.map((l, i) => (
                      <div key={i} className="text-xs">
                        {placeLabel(l.from)} → {placeLabel(l.to)}: {l.miles.toFixed(1)} mi
                      </div>
                    ))}
                    <div className="font-medium">{route.miles.toFixed(1)} mi</div>
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Tolls (optional)
              <input inputMode="decimal" value={tolls} onChange={(e) => setTolls(e.target.value)} placeholder="$0.00" className={INPUT} />
            </label>
            <label className={label}>
              Parking (optional)
              <input inputMode="decimal" value={parking} onChange={(e) => setParking(e.target.value)} placeholder="$0.00" className={INPUT} />
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-sm text-slate-700 dark:text-slate-300">Receipts (photos or PDF)</div>
            <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => addFiles(e.target.files, "receipts")} className="text-sm" />
            <FilePreviews files={receiptFiles} noun="Receipt" onRemove={(p) => setReceiptFiles(receiptFiles.filter((f) => f.path !== p))} />
          </div>

          <div className="text-sm text-slate-700 dark:text-slate-300">
            {estimate == null
              ? "Amount: fill in the miles and amounts."
              : estimate.total_cents == null
                ? `There is no Mileage rate for ${tripDate}.`
                : `Amount: ${money(estimate.total_cents)}${estimate.rate != null && estimate.mileage_cents ? ` (Mileage at ${estimate.rate}¢/mi, the IRS rate for the trip date)` : ""}`}
          </div>
        </>
      )}

      {err && <div className="text-sm text-rose-600 dark:text-rose-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button type="button" className={PRIMARY} onClick={submit} disabled={!!busy}>
          {busy ?? (how === "lyft" ? "File Lyft ride report" : editing ? "Save" : "Submit")}
        </button>
        <button type="button" className={BUTTON} onClick={onCancel} disabled={!!busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
