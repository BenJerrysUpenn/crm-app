"use client";

import type { ReactNode } from "react";
import GenerateDealSlot from "./GenerateDealSlot";
import RecordingUploader from "./RecordingUploader";
import {
  dispositionLabel,
  type CallDeskRow,
  type Disposition,
} from "@/lib/callDesk/types";
import type { FacetKey } from "@/lib/callDesk/filters";
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
  do_not_call: "bg-rose-500/20 text-rose-300 border-rose-500/30",
};

type FacetTap = (key: FacetKey, value: string) => void;

/**
 * What the Party type cell should say (bj-finance #414).
 *
 * The package they booked is the answer to "why did this person contact us".
 * Most prospects don't have one: the Salesforce migration dropped the Party
 * Type field, so 9,447 of 9,450 legacy deals have no package_name. The booked
 * event type is the next best thing and is shown labelled as such, never
 * dressed up as a package. Anything weaker is "—" — this column is about
 * bookings, so an enquiry's event type does not belong in it.
 */
export type PartyTypeCell = {
  kind: "package" | "event_type";
  value: string;
  facetKey: FacetKey;
};

export function partyTypeCell(row: CallDeskRow): PartyTypeCell | null {
  if (row.party_type_booked?.trim())
    return {
      kind: "package",
      value: row.party_type_booked.trim(),
      facetKey: "party_type_booked",
    };
  if (row.booked_event_type?.trim())
    return {
      kind: "event_type",
      value: row.booked_event_type.trim(),
      facetKey: "booked_event_type",
    };
  return null;
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

/** The party type itself: tappable, and honest about which column it came from. */
function PartyTypeValue({
  cell,
  onFacetTap,
}: {
  cell: PartyTypeCell;
  onFacetTap: FacetTap;
}) {
  return (
    <>
      <TapFilter
        onFacetTap={onFacetTap}
        facetKey={cell.facetKey}
        value={cell.value}
        what={
          cell.kind === "package"
            ? `party type ${cell.value}`
            : `booked event type ${cell.value}`
        }
      >
        {cell.value}
      </TapFilter>
      {cell.kind === "event_type" && (
        <span className="text-slate-500"> (event type)</span>
      )}
    </>
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
};

function RowActions({
  row,
  pendingEventId,
  recordingEventId,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  recordingEventId: number | null;
  handlers: RowHandlers;
}) {
  const href = telHref(row.phone);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        {/* One open call at a time (bj-finance #413): while the last one has
            no outcome, Call now is dead and the number shows in its place so
            it can still be dialled by hand. */}
        {pendingEventId ? (
          <span
            aria-disabled="true"
            title="Log the outcome of the last call first"
            className="min-h-[44px] flex-1 min-w-[7rem] flex items-center justify-center text-sm text-slate-400 select-all rounded-md px-3 border border-slate-800 bg-slate-900"
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

      {pendingEventId && (
        <p className="mt-2 text-xs text-rose-300">
          Log the outcome of the last call first
        </p>
      )}

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
  recordingEventId,
  expanded,
  onToggle,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  recordingEventId: number | null;
  expanded: boolean;
  onToggle: () => void;
  handlers: RowHandlers;
}) {
  const cell = partyTypeCell(row);
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
            {!pendingEventId && row.last_disposition && (
              <DispositionChip
                value={row.last_disposition}
                onFacetTap={handlers.onFacetTap}
              />
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
          </div>
          <div className="col-span-2 text-slate-400 truncate">
            {cell ? (
              <>
                Party type:{" "}
                <PartyTypeValue cell={cell} onFacetTap={handlers.onFacetTap} />
              </>
            ) : (
              "No previous party type"
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
  recordingEventId,
  expanded,
  onToggle,
  handlers,
}: {
  row: CallDeskRow;
  pendingEventId: number | null;
  recordingEventId: number | null;
  expanded: boolean;
  onToggle: () => void;
  handlers: RowHandlers;
}) {
  const cell = partyTypeCell(row);
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
        </td>
        <td className="px-3 py-3 text-sm text-slate-300">
          <div>
            {cell ? (
              <PartyTypeValue cell={cell} onFacetTap={handlers.onFacetTap} />
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
            {!pendingEventId && row.last_disposition && (
              <DispositionChip
                value={row.last_disposition}
                onFacetTap={handlers.onFacetTap}
              />
            )}
            {!pendingEventId && !row.last_disposition && (
              <span className="text-xs text-slate-500">—</span>
            )}
          </div>
        </td>
        <td className="px-3 py-3 w-[22rem]">
          <RowActions
            row={row}
            pendingEventId={pendingEventId}
            recordingEventId={recordingEventId}
            handlers={handlers}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/40">
          <td colSpan={7} className="px-3 pb-4">
            <RowDetails row={row} onFacetTap={handlers.onFacetTap} />
          </td>
        </tr>
      )}
    </>
  );
}
