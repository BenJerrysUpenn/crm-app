"use client";

import GenerateDealSlot from "./GenerateDealSlot";
import RecordingUploader from "./RecordingUploader";
import {
  dispositionLabel,
  type CallDeskRow,
  type Disposition,
} from "@/lib/callDesk/types";
import {
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

/** The "party type they previously booked", with the fallbacks the spec asks for. */
export function partyType(row: CallDeskRow): string | null {
  return row.party_type_booked || row.booked_event_type || row.last_event_type;
}

function DispositionChip({ value }: { value: Disposition }) {
  return (
    <span
      className={`inline-block text-[11px] px-2 py-0.5 rounded border whitespace-nowrap ${DISPOSITION_CHIP[value]}`}
    >
      {dispositionLabel(value)}
    </span>
  );
}

export function PendingBadge() {
  return (
    <span className="inline-block text-[11px] px-2 py-0.5 rounded border bg-rose-500/20 text-rose-200 border-rose-500/40 whitespace-nowrap">
      Disposition needed
    </span>
  );
}

function BookedBadge() {
  return (
    <span className="inline-block text-[11px] px-2 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/30 whitespace-nowrap">
      Booked before
    </span>
  );
}

export type RowHandlers = {
  callerEmail: string;
  onCall: (row: CallDeskRow) => void;
  onLogOutcome: (row: CallDeskRow, eventId: number) => void;
  onNote: (row: CallDeskRow) => void;
  onRefresh: () => void;
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
        {href ? (
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

      <RecordingUploader
        eventId={recordingEventId}
        onUploaded={() => handlers.onRefresh()}
      />
    </div>
  );
}

function RowDetails({ row }: { row: CallDeskRow }) {
  return (
    <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-2">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-slate-500">Email</dt>
        <dd className="break-all text-slate-300">{row.email || "—"}</dd>
        <dt className="text-slate-500">City / category</dt>
        <dd className="text-slate-300">
          {[row.city, row.category].filter(Boolean).join(" · ") || "—"}
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
  const type = partyType(row);
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
              <DispositionChip value={row.last_disposition} />
            )}
            {row.ever_booked && <div>{<BookedBadge />}</div>}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div>
            <div className="text-slate-300">
              {fmtLastContact(row.last_contact_type, row.last_contact_at)}
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
            {type ? `Party type: ${type}` : "No previous party type"}
          </div>
        </div>

        {expanded && <RowDetails row={row} />}
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
  const type = partyType(row);
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
            {fmtLastContact(row.last_contact_type, row.last_contact_at)}
          </div>
          <div className="text-xs text-slate-500">
            {fmtStamp(row.last_contact_at) || "—"}
          </div>
        </td>
        <td className="px-3 py-3 text-sm text-slate-300 whitespace-nowrap">
          {row.phone || "—"}
        </td>
        <td className="px-3 py-3 text-sm text-slate-300">
          <div>{type || "—"}</div>
          {row.ever_booked && (
            <div className="mt-1">
              <BookedBadge />
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
              <DispositionChip value={row.last_disposition} />
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
            <RowDetails row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
