"use client";

import { useState, type ReactNode } from "react";
import GenerateDealSlot from "./GenerateDealSlot";
import RecordingUploader from "./RecordingUploader";
import {
  dispositionLabel,
  DNC_STATUS_LABEL,
  type CallDeskRow,
  type Disposition,
} from "@/lib/callDesk/types";
import type { FacetKey } from "@/lib/callDesk/filters";
import {
  BLOCK_HINT,
  openingScript,
  type BlockReason,
} from "@/lib/callDesk/compliance";
import {
  contactTypeLabel,
  fmtLastContact,
  fmtMoney,
  fmtRelative,
  fmtStamp,
  telHref,
} from "@/lib/callDesk/format";
import { fmtEasternDate } from "@/lib/dateFormat";

const DISPOSITION_CHIP: Record<Disposition, string> = {
  no_answer: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  voicemail: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  spoke: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  interested: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  lost: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  do_not_call: "bg-rose-500/20 text-rose-300 border-rose-500/30",
};

/**
 * "window until Sep 4, 2027", or "expired" in amber (bj-finance #420).
 *
 * The row stays fully workable either way — expired only greys the phone
 * button. What this line does is tell the caller which it is before he
 * wonders why the button is dead.
 */
function WindowLine({ row }: { row: CallDeskRow }) {
  if (row.ebr_active && row.ebr_expires_on)
    return (
      <span className="text-[11px] text-slate-500">
        window until {fmtEasternDate(row.ebr_expires_on)}
      </span>
    );
  if (row.dnc_status === "clear")
    return (
      <span className="text-[11px] text-emerald-400/80">
        expired · scrubbed clear
      </span>
    );
  return (
    <span className="text-[11px] text-amber-400/90">
      {row.ebr_expires_on
        ? `expired ${fmtEasternDate(row.ebr_expires_on)}`
        : "expired — no relationship on file"}
    </span>
  );
}

/** A prospect marked "Not now / lost" on a call (bj-finance #421). */
function LostBadge() {
  return (
    <span
      title="No sale on the phone. Still on the marketing email list."
      className="inline-block text-[11px] px-2 py-0.5 rounded border bg-slate-500/20 text-slate-300 border-slate-500/40 whitespace-nowrap"
    >
      Lost (still emailed)
    </span>
  );
}

/**
 * "Say first" — the one line Joey reads before any pitch (47 CFR
 * 64.1200(d)(4), 73 P.S. 2245(a)(5)). Collapsed so it does not shove the
 * buttons down the screen; 44px so it can be opened with a thumb.
 */
function OpeningScript({
  row,
  callerEmail,
}: {
  row: CallDeskRow;
  callerEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const script = openingScript(row, callerEmail);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="min-h-[44px] w-full text-left text-xs text-sky-300 hover:text-sky-200 flex items-center gap-2"
      >
        <span aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span>
        Say first
      </button>
      {open && (
        <p className="text-xs text-slate-200 bg-slate-950 border border-slate-800 rounded px-3 py-2">
          {script}
        </p>
      )}
    </div>
  );
}

type FacetTap = (key: FacetKey, value: string) => void;

/**
 * What the Event type cell should say (bj-finance #414).
 *
 * Alina reads the desk for "corporate or birthday party or whatever", not for
 * the package that was bought, so the event type is the primary column. The
 * booked deal's event type is the strongest answer; failing that the most
 * recent deal's, which after the cake backfill reads "Cake Order" for past
 * cake customers and carries the enquiry's event type for people who asked
 * but never booked. Each source has its own facet, so a tap filters the one
 * the cell actually showed.
 */
export type EventTypeCell = {
  value: string;
  facetKey: Extract<FacetKey, "booked_event_type" | "last_event_type">;
};

export function eventTypeCell(row: CallDeskRow): EventTypeCell | null {
  if (row.booked_event_type?.trim())
    return {
      value: row.booked_event_type.trim(),
      facetKey: "booked_event_type",
    };
  if (row.last_event_type?.trim())
    return { value: row.last_event_type.trim(), facetKey: "last_event_type" };
  return null;
}

/**
 * The Package cell: the package_name of the last booked deal, and nothing
 * else. Secondary and muted — it is what they bought, not why they called.
 * Mostly empty by nature: the Salesforce translator dropped Party Type, and
 * the #414 backfill recovered it for only part of the base.
 */
export function packageCell(row: CallDeskRow): string | null {
  return row.party_type_booked?.trim() || null;
}

/**
 * A value in the row that filters the queue when tapped (bj-finance #412).
 * stopPropagation keeps the card / table row from expanding underneath.
 */
function TapFilter({
  onFacetTap,
  facetKey,
  value,
  what,
  className = "",
  children,
}: {
  onFacetTap: FacetTap;
  facetKey: FacetKey;
  value: string;
  /** Completes "Filter by …" for the tooltip and the screen-reader label. */
  what: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onFacetTap(facetKey, value);
      }}
      title={`Filter by ${what}`}
      aria-label={`Filter by ${what}`}
      className={`cursor-pointer text-left hover:underline focus:underline underline-offset-2 ${className}`}
    >
      {children}
    </button>
  );
}

function DispositionChip({
  value,
  onFacetTap,
}: {
  value: Disposition;
  onFacetTap: FacetTap;
}) {
  return (
    <TapFilter
      onFacetTap={onFacetTap}
      facetKey="last_disposition"
      value={value}
      what={`outcome ${dispositionLabel(value)}`}
    >
      <span
        className={`inline-block text-[11px] px-2 py-0.5 rounded border whitespace-nowrap ${DISPOSITION_CHIP[value]}`}
      >
        {dispositionLabel(value)}
      </span>
    </TapFilter>
  );
}

export function PendingBadge() {
  return (
    <span className="inline-block text-[11px] px-2 py-0.5 rounded border bg-rose-500/20 text-rose-200 border-rose-500/40 whitespace-nowrap">
      Disposition needed
    </span>
  );
}

function BookedBadge({ onFacetTap }: { onFacetTap: FacetTap }) {
  return (
    <TapFilter
      onFacetTap={onFacetTap}
      facetKey="ever_booked"
      value="yes"
      what="prospects who booked before"
    >
      <span className="inline-block text-[11px] px-2 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/30 whitespace-nowrap">
        Booked before
      </span>
    </TapFilter>
  );
}

/** "Call · 1h ago", with the type half tappable. */
function LastContact({
  row,
  onFacetTap,
}: {
  row: CallDeskRow;
  onFacetTap: FacetTap;
}) {
  const type = row.last_contact_type;
  if (!type) return <>{fmtLastContact(type, row.last_contact_at)}</>;
  const label = contactTypeLabel(type);
  const rel = fmtRelative(row.last_contact_at);
  return (
    <>
      <TapFilter
        onFacetTap={onFacetTap}
        facetKey="last_contact_type"
        value={type}
        what={`last contact ${label}`}
      >
        {label}
      </TapFilter>
      {rel ? ` · ${rel}` : ""}
    </>
  );
}

/** The event type itself: tappable, filtering whichever column it came from. */
function EventTypeValue({
  cell,
  onFacetTap,
}: {
  cell: EventTypeCell;
  onFacetTap: FacetTap;
}) {
  return (
    <TapFilter
      onFacetTap={onFacetTap}
      facetKey={cell.facetKey}
      value={cell.value}
      what={`event type ${cell.value}`}
    >
      {cell.value}
    </TapFilter>
  );
}

/** The package, muted. Tapping filters the booked package. */
function PackageValue({
  value,
  onFacetTap,
}: {
  value: string;
  onFacetTap: FacetTap;
}) {
  return (
    <TapFilter
      onFacetTap={onFacetTap}
      facetKey="party_type_booked"
      value={value}
      what={`package ${value}`}
    >
      {value}
    </TapFilter>
  );
}

export type RowHandlers = {
  callerEmail: string;
  onCall: (row: CallDeskRow) => void;
  onLogOutcome: (row: CallDeskRow, eventId: number) => void;
  onNote: (row: CallDeskRow) => void;
  onRefresh: () => void;
  /** Tapping a value in a row adds it to the facet filters. */
  onFacetTap: FacetTap;
  /** A recording landed on this call — it can no longer be undone. */
  onRecordingUploaded: (eventId: number) => void;
  /** Put a "Not now / lost" prospect back in the call queue (#421). */
  onReopen: (row: CallDeskRow) => void;
};

function RowActions({
  row,
  pendingEventId,
  blockReason,
  recordingEventId,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  /** Why the phone is greyed out, or null when it may be dialled. */
  blockReason: BlockReason | null;
  recordingEventId: number | null;
  handlers: RowHandlers;
}) {
  const href = telHref(row.phone);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        {/* Only the phone is ever blocked (bj-finance #420, Alina 2026-09-10:
            "just gray out the call button"). The number stays on screen and
            stays selectable, so a lawful call can always be dialled by hand,
            and everything else on the row keeps working — this desk is where
            the email outreach gets worked too. */}
        {blockReason ? (
          <span
            aria-disabled="true"
            title={BLOCK_HINT[blockReason]}
            className="min-h-[44px] flex-1 min-w-[7rem] flex items-center justify-center text-sm text-slate-400 select-all rounded-md px-3 border border-slate-800 bg-slate-900 opacity-70"
          >
            {row.phone || "No phone"}
          </span>
        ) : href ? (
          <a
            href={href}
            onClick={() => handlers.onCall(row)}
            className="min-h-[44px] flex-1 min-w-[7rem] flex items-center justify-center text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md px-3 border border-emerald-500"
          >
            Call now
          </a>
        ) : (
          <span className="min-h-[44px] flex-1 min-w-[7rem] flex items-center justify-center text-sm text-slate-500 rounded-md px-3 border border-slate-800">
            No phone
          </span>
        )}

        <button
          type="button"
          onClick={() =>
            pendingEventId && handlers.onLogOutcome(row, pendingEventId)
          }
          disabled={!pendingEventId}
          className={`min-h-[44px] flex-1 min-w-[7rem] text-sm rounded-md px-3 border disabled:opacity-40 disabled:cursor-not-allowed ${
            pendingEventId
              ? "bg-rose-600/90 hover:bg-rose-500 text-white border-rose-500"
              : "bg-slate-800 text-slate-300 border-slate-700"
          }`}
        >
          Log outcome
        </button>

        <button
          type="button"
          onClick={() => handlers.onNote(row)}
          className="min-h-[44px] flex-1 min-w-[6rem] text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md px-3 border border-slate-700"
        >
          Note
        </button>

        <GenerateDealSlot
          prospect={row}
          callerEmail={handlers.callerEmail}
          onCreated={() => handlers.onRefresh()}
        />
      </div>

      {blockReason && (
        <p
          className={`mt-2 text-xs ${
            blockReason === "pending_outcome" ? "text-rose-300" : "text-amber-300"
          }`}
        >
          {BLOCK_HINT[blockReason]}
        </p>
      )}

      {/* The row's own undo for "Not now / lost" (bj-finance #421). */}
      {row.status === "called_lost" && (
        <button
          type="button"
          onClick={() => handlers.onReopen(row)}
          className="mt-2 min-h-[44px] w-full text-sm rounded-md px-3 border bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
        >
          Reopen for calling
        </button>
      )}

      <OpeningScript row={row} callerEmail={handlers.callerEmail} />

      <RecordingUploader
        eventId={recordingEventId}
        onUploaded={() => {
          if (recordingEventId) handlers.onRecordingUploaded(recordingEventId);
          handlers.onRefresh();
        }}
      />
    </div>
  );
}

function RowDetails({
  row,
  onFacetTap,
}: {
  row: CallDeskRow;
  onFacetTap: FacetTap;
}) {
  return (
    <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-2">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-slate-500">Email</dt>
        <dd className="break-all text-slate-300">{row.email || "—"}</dd>
        <dt className="text-slate-500">City / category</dt>
        <dd className="text-slate-300">
          {row.city || row.category ? (
            <>
              {row.city && (
                <TapFilter
                  onFacetTap={onFacetTap}
                  facetKey="city"
                  value={row.city}
                  what={`city ${row.city}`}
                >
                  {row.city}
                </TapFilter>
              )}
              {row.city && row.category ? " · " : ""}
              {row.category && (
                <TapFilter
                  onFacetTap={onFacetTap}
                  facetKey="category"
                  value={row.category}
                  what={`category ${row.category}`}
                >
                  {row.category}
                </TapFilter>
              )}
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-slate-500">Lifetime value</dt>
        <dd className="text-slate-300">
          {fmtMoney(row.lifetime_value)}
          {row.deal_count ? ` · ${row.deal_count} deal(s)` : ""}
        </dd>
        <dt className="text-slate-500">Last event</dt>
        <dd className="text-slate-300">
          {row.last_event_date ? fmtEasternDate(row.last_event_date) : "—"}
        </dd>
        <dt className="text-slate-500">Last deal</dt>
        <dd className="text-slate-300">
          {/* The board has no ?deal=<id> deep link, so the id is plain text. */}
          {row.last_deal_id
            ? `#${row.last_deal_id}${
                row.last_deal_stage ? ` · ${row.last_deal_stage}` : ""
              }`
            : "—"}
        </dd>
        <dt className="text-slate-500">Relationship</dt>
        <dd className="text-slate-300">
          {row.ebr_basis === "purchase"
            ? `Booked ${row.last_paid_event_date ? fmtEasternDate(row.last_paid_event_date) : ""}`.trim()
            : row.ebr_basis === "inquiry"
              ? `Enquired ${row.last_inquiry_at ? fmtEasternDate(row.last_inquiry_at) : ""}`.trim()
              : "Nothing on file — our emails don't count"}
          {row.ebr_expires_on && (
            <>
              {" · "}
              {row.ebr_active ? "window until " : "expired "}
              {fmtEasternDate(row.ebr_expires_on)}
            </>
          )}
        </dd>
        <dt className="text-slate-500">Registry scrub</dt>
        <dd className="text-slate-300">
          <TapFilter
            onFacetTap={onFacetTap}
            facetKey="dnc_status"
            value={row.dnc_status ?? "unknown"}
            what={`scrub ${DNC_STATUS_LABEL[row.dnc_status ?? "unknown"]}`}
          >
            {DNC_STATUS_LABEL[row.dnc_status ?? "unknown"]}
          </TapFilter>
          {row.dnc_checked_at ? ` · ${fmtStamp(row.dnc_checked_at)}` : ""}
        </dd>
        <dt className="text-slate-500">Last call</dt>
        <dd className="text-slate-300">
          {row.last_call_at
            ? `${fmtStamp(row.last_call_at)}${
                row.last_call_by ? ` · ${row.last_call_by}` : ""
              }`
            : "—"}
        </dd>
      </dl>

      <div>
        <div className="text-slate-500 mb-1">Notes</div>
        {row.notes?.trim() ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-slate-300 bg-slate-950 border border-slate-800 rounded px-2 py-2 max-h-40 overflow-y-auto">
            {row.notes}
          </pre>
        ) : (
          <div className="text-slate-500">No notes yet.</div>
        )}
      </div>
    </div>
  );
}

/** Mobile: one card per prospect. Tap the card body to expand details. */
export function ProspectCard({
  row,
  pendingEventId,
  blockReason,
  recordingEventId,
  expanded,
  onToggle,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  blockReason: BlockReason | null;
  recordingEventId: number | null;
  expanded: boolean;
  onToggle: () => void;
  handlers: RowHandlers;
}) {
  const eventType = eventTypeCell(row);
  const pkg = packageCell(row);
  return (
    <li
      className={`rounded-lg border bg-slate-900 px-3 py-3 ${
        pendingEventId ? "border-rose-800" : "border-slate-800"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="cursor-pointer"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-slate-100 font-medium truncate">
              {row.name || row.company || `Prospect ${row.prospect_id}`}
            </div>
            <div className="text-xs text-slate-400 truncate">
              {[row.title, row.company].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
          <div className="shrink-0 text-right space-y-1">
            {pendingEventId && <PendingBadge />}
            {/* The Lost badge already says it; two chips saying one thing is
                noise. */}
            {!pendingEventId &&
              row.last_disposition &&
              row.status !== "called_lost" && (
                <DispositionChip
                  value={row.last_disposition}
                  onFacetTap={handlers.onFacetTap}
                />
              )}
            {row.status === "called_lost" && (
              <div>
                <LostBadge />
              </div>
            )}
            {row.ever_booked && (
              <div>
                <BookedBadge onFacetTap={handlers.onFacetTap} />
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div>
            <div className="text-slate-300">
              <LastContact row={row} onFacetTap={handlers.onFacetTap} />
            </div>
            <div className="text-slate-500">
              {fmtStamp(row.last_contact_at) || "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-slate-300">{row.phone || "No phone"}</div>
            <div className="text-slate-500">
              {row.calls_count === 1
                ? "1 call"
                : `${row.calls_count ?? 0} calls`}
            </div>
            <div>
              <WindowLine row={row} />
            </div>
          </div>
          {/* "Birthday Party · Sundae Party" — event type first and readable,
              package second and muted (bj-finance #414). */}
          <div className="col-span-2 truncate">
            <span className="text-slate-300">
              {eventType ? (
                <EventTypeValue
                  cell={eventType}
                  onFacetTap={handlers.onFacetTap}
                />
              ) : (
                "—"
              )}
            </span>
            {pkg && (
              <span className="text-slate-500">
                {" · "}
                <PackageValue value={pkg} onFacetTap={handlers.onFacetTap} />
              </span>
            )}
          </div>
        </div>

        {expanded && (
          <RowDetails row={row} onFacetTap={handlers.onFacetTap} />
        )}
      </div>

      <div className="mt-3">
        <RowActions
          row={row}
          pendingEventId={pendingEventId}
          blockReason={blockReason}
          recordingEventId={recordingEventId}
          handlers={handlers}
        />
      </div>
    </li>
  );
}

/** Desktop (md+): the same data as a table row, details on a second row. */
export function ProspectTableRow({
  row,
  pendingEventId,
  blockReason,
  recordingEventId,
  expanded,
  onToggle,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  blockReason: BlockReason | null;
  recordingEventId: number | null;
  expanded: boolean;
  onToggle: () => void;
  handlers: RowHandlers;
}) {
  const eventType = eventTypeCell(row);
  const pkg = packageCell(row);
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer align-top border-t border-slate-800 hover:bg-slate-900/60 ${
          pendingEventId ? "bg-rose-950/20" : ""
        }`}
      >
        <td className="px-3 py-3">
          <div className="text-slate-100 font-medium">
            {row.name || row.company || `Prospect ${row.prospect_id}`}
          </div>
          <div className="text-xs text-slate-400">
            {[row.title, row.company].filter(Boolean).join(" · ") || "—"}
          </div>
        </td>
        <td className="px-3 py-3">
          <div className="text-slate-300 text-sm">
            <LastContact row={row} onFacetTap={handlers.onFacetTap} />
          </div>
          <div className="text-xs text-slate-500">
            {fmtStamp(row.last_contact_at) || "—"}
          </div>
        </td>
        <td className="px-3 py-3 text-sm text-slate-300 whitespace-nowrap">
          {row.phone || "—"}
          <div>
            <WindowLine row={row} />
          </div>
        </td>
        <td className="px-3 py-3 text-sm text-slate-300">
          <div>
            {eventType ? (
              <EventTypeValue cell={eventType} onFacetTap={handlers.onFacetTap} />
            ) : (
              "—"
            )}
          </div>
          {row.ever_booked && (
            <div className="mt-1">
              <BookedBadge onFacetTap={handlers.onFacetTap} />
            </div>
          )}
        </td>
        <td className="px-3 py-3 text-sm text-slate-500">
          {pkg ? (
            <PackageValue value={pkg} onFacetTap={handlers.onFacetTap} />
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-3 text-sm text-slate-300 text-center">
          {row.calls_count ?? 0}
          {row.last_call_at && (
            <div className="text-xs text-slate-500">
              {fmtRelative(row.last_call_at)}
            </div>
          )}
        </td>
        <td className="px-3 py-3">
          <div className="space-y-1">
            {pendingEventId && <PendingBadge />}
            {/* The Lost badge already says it; two chips saying one thing is
                noise. */}
            {!pendingEventId &&
              row.last_disposition &&
              row.status !== "called_lost" && (
                <DispositionChip
                  value={row.last_disposition}
                  onFacetTap={handlers.onFacetTap}
                />
              )}
            {row.status === "called_lost" && <LostBadge />}
            {!pendingEventId &&
              !row.last_disposition &&
              row.status !== "called_lost" && (
                <span className="text-xs text-slate-500">—</span>
              )}
          </div>
        </td>
        <td className="px-3 py-3 w-[22rem]">
          <RowActions
            row={row}
            pendingEventId={pendingEventId}
            blockReason={blockReason}
            recordingEventId={recordingEventId}
            handlers={handlers}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/40">
          <td colSpan={8} className="px-3 pb-4">
            <RowDetails row={row} onFacetTap={handlers.onFacetTap} />
          </td>
        </tr>
      )}
    </>
  );
}
