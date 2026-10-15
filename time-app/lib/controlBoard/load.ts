// Server-side reads for the control board (the Targets tab) and the Team
// page's salaries. Reads as the signed-in manager, so Row Level Security
// (migration 43) is the second line behind the page's own gate.
//
// Before migration 43 is applied the board says so instead of drawing an
// empty board; a sales-history read that fails is reported, and the trend
// factor shows as missing, never as zero.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import type { SalaryRow, SettingRow } from "./settings";
import { monthStart, trendMonths, type DailySalesRow, type MonthlySalesRow } from "./math";

export const NEEDS_MIGRATION = "The control board needs migration 43. Run time-app/supabase/migration_43.sql in the Supabase SQL editor first.";

export type SalariedProfile = { id: string; name: string };

export type BoardLoad =
  | {
      ready: true;
      settings: SettingRow[];
      salaries: SalaryRow[];
      salaried: SalariedProfile[];
      monthly: MonthlySalesRow[];
      daily: DailySalesRow[];
      problems: string[];
    }
  | { ready: false; reason: string };

const num = (v: unknown) => (v == null ? v : Number(v));

function settingRow(r: Record<string, unknown>): SettingRow {
  return { ...(r as SettingRow), value: Number(r.value), detail: (r.detail as SettingRow["detail"]) ?? {} };
}

function salaryRow(r: Record<string, unknown>): SalaryRow {
  return { ...(r as SalaryRow), annual_salary: Number(r.annual_salary) };
}

/** Every stored salary row, or null before migration 43. */
export async function loadSalaries(supabase: SupabaseClient): Promise<SalaryRow[] | null> {
  const { data, error } = await supabase.from("profile_salaries").select("*");
  if (isMissingTable(error)) return null;
  if (error) throw new Error(`profile_salaries: ${error.message}`);
  return ((data as Record<string, unknown>[]) ?? []).map(salaryRow);
}

export async function loadBoard(supabase: SupabaseClient, today: string): Promise<BoardLoad> {
  const [settingsRes, salariesRes, peopleRes] = await Promise.all([
    supabase.from("control_settings").select("*"),
    supabase.from("profile_salaries").select("*"),
    supabase.from("profiles").select("id, full_name").eq("active", true).eq("pay_type", "salaried").order("full_name"),
  ]);
  if (isMissingTable(settingsRes.error) || isMissingTable(salariesRes.error)) return { ready: false, reason: NEEDS_MIGRATION };
  if (settingsRes.error) return { ready: false, reason: `The settings could not be read: ${settingsRes.error.message}` };
  if (salariesRes.error) return { ready: false, reason: `The salaries could not be read: ${salariesRes.error.message}` };
  if (peopleRes.error) return { ready: false, reason: `The team could not be read: ${peopleRes.error.message}` };

  const problems: string[] = [];
  const { last, lastYear } = trendMonths(today);
  const monthOf = (month: string) =>
    supabase.from("sales_daily_in_store").select("day, in_store, basis, source").gte("day", month).lt("day", monthStart(month, 1));
  const [monthlyRes, lastDays, lastYearDays] = await Promise.all([
    supabase.from("sales_monthly").select("month, source, in_store").in("month", [last, lastYear]),
    monthOf(last),
    monthOf(lastYear),
  ]);
  if (monthlyRes.error) problems.push(`Monthly sales could not be read: ${monthlyRes.error.message}`);
  const dailyError = lastDays.error ?? lastYearDays.error;
  if (dailyError) problems.push(`Daily sales could not be read: ${dailyError.message}`);
  const dailyRes = { data: [...(lastDays.data ?? []), ...(lastYearDays.data ?? [])] };

  return {
    ready: true,
    settings: ((settingsRes.data as Record<string, unknown>[]) ?? []).map(settingRow),
    salaries: ((salariesRes.data as Record<string, unknown>[]) ?? []).map(salaryRow),
    salaried: ((peopleRes.data as { id: string; full_name: string | null }[]) ?? []).map((p) => ({ id: p.id, name: p.full_name ?? "Unnamed" })),
    monthly: ((monthlyRes.data as Record<string, unknown>[]) ?? []).map((r) => ({ ...(r as MonthlySalesRow), in_store: num(r.in_store) as number })),
    daily: ((dailyRes.data as Record<string, unknown>[]) ?? []).map((r) => ({ ...(r as DailySalesRow), in_store: num(r.in_store) as number })),
    problems,
  };
}
