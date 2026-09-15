// Parsing and validation of the three staffing forms. Pure functions: a
// request body in, a typed form or an error string out.
import type { Role } from "@/lib/types";
import {
  COMP_TYPES_DEFAULT,
  FINAL_PAY_NOTE_DEFAULT,
  PAY_SCHEDULE_DEFAULT,
  type OffboardingForm,
  type OnboardingForm,
  type PayrollSetupForm,
} from "./catalogue";

type Body = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(b: Body, k: string): string {
  const v = b[k];
  return typeof v === "string" ? v.trim() : "";
}
function optStr(b: Body, k: string): string | null {
  const s = str(b, k);
  return s || null;
}
function num(b: Body, k: string): number | null {
  const v = b[k];
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return null;
}
function strList(b: Body, k: string): string[] {
  const v = b[k];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}
function date(b: Body, k: string): string | null {
  const s = str(b, k);
  return DATE_RE.test(s) ? s : null;
}
function email(b: Body, k: string): string | null {
  const s = str(b, k).toLowerCase();
  return s.includes("@") ? s : null;
}
function uuid(b: Body, k: string): string | null {
  const s = str(b, k);
  return /^[0-9a-f-]{36}$/i.test(s) ? s : null;
}

export type Parsed<T> = { ok: true; form: T } | { ok: false; error: string };

export function parseOnboarding(b: Body): Parsed<OnboardingForm> {
  const legal_name = str(b, "legal_name");
  if (!legal_name || legal_name.includes("@")) return { ok: false, error: "Legal name required (not an email)." };
  const em = email(b, "email");
  if (!em) return { ok: false, error: "Valid email required." };
  const start_date = date(b, "start_date");
  if (!start_date) return { ok: false, error: "Start date required (YYYY-MM-DD)." };
  const role: Role = str(b, "role") === "manager" ? "manager" : "employee";
  const pay_rate = num(b, "pay_rate");
  if (pay_rate !== null && pay_rate < 0) return { ok: false, error: "Pay rate cannot be negative." };
  return {
    ok: true,
    form: {
      legal_name,
      preferred_name: optStr(b, "preferred_name"),
      email: em,
      phone: optStr(b, "phone"),
      role,
      start_date,
      pay_rate,
      position_types: strList(b, "position_types"),
      fob_card_id: optStr(b, "fob_card_id"),
    },
  };
}

export function parsePayrollSetup(b: Body): Parsed<PayrollSetupForm> {
  const employee_id = uuid(b, "employee_id");
  if (!employee_id) return { ok: false, error: "Pick the person." };
  const legal_name = str(b, "legal_name");
  if (!legal_name || legal_name.includes("@")) return { ok: false, error: "Legal name required (not an email)." };
  const em = email(b, "email");
  if (!em) return { ok: false, error: "Valid email required." };
  const hire_date = date(b, "hire_date");
  if (!hire_date) return { ok: false, error: "Hire date required (YYYY-MM-DD)." };
  const pay_type = str(b, "pay_type") === "salary" ? "salary" : "hourly";
  const pay_rate = num(b, "pay_rate");
  if (pay_rate === null || pay_rate <= 0) return { ok: false, error: "Pay rate required." };
  const comp = strList(b, "comp_types");
  return {
    ok: true,
    form: {
      employee_id,
      legal_name,
      email: em,
      hire_date,
      pay_type,
      pay_rate,
      pay_schedule: str(b, "pay_schedule") || PAY_SCHEDULE_DEFAULT,
      job_title: optStr(b, "job_title"),
      comp_types: comp.length ? comp : COMP_TYPES_DEFAULT,
      qbo_employee_id: optStr(b, "qbo_employee_id"),
    },
  };
}

export function parseOffboarding(
  b: Body,
  lookup: { name: string; email: string | null } | null,
): Parsed<OffboardingForm> {
  const employee_id = uuid(b, "employee_id");
  if (!employee_id) return { ok: false, error: "Pick the person." };
  if (!lookup) return { ok: false, error: "No such team member." };
  const last_day = date(b, "last_day");
  if (!last_day) return { ok: false, error: "Last day required (YYYY-MM-DD)." };
  const reason = str(b, "reason");
  if (!reason) return { ok: false, error: "Reason required." };
  return {
    ok: true,
    form: {
      employee_id,
      employee_name: lookup.name,
      employee_email: lookup.email,
      last_day,
      reason,
      reason_note: optStr(b, "reason_note"),
      final_pay_note: str(b, "final_pay_note") || FINAL_PAY_NOTE_DEFAULT,
    },
  };
}

// Today's date in America/New_York as YYYY-MM-DD, for "is the last day past?".
export function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
