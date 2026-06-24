import type { SupabaseClient } from "@supabase/supabase-js";

export type AppSettings = {
  employee_clockin_grace_min: number;
  manager_clockin_grace_min: number;
  tardy_grace_min: number;
  shift_reminder_lead_min: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  employee_clockin_grace_min: 5,
  manager_clockin_grace_min: 15,
  tardy_grace_min: 15,
  shift_reminder_lead_min: 30,
};

// Reads the single settings row; falls back to defaults if missing.
export async function getSettings(
  supabase: SupabaseClient,
): Promise<AppSettings> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (!data) return DEFAULT_SETTINGS;
    return {
      employee_clockin_grace_min: data.employee_clockin_grace_min ?? DEFAULT_SETTINGS.employee_clockin_grace_min,
      manager_clockin_grace_min: data.manager_clockin_grace_min ?? DEFAULT_SETTINGS.manager_clockin_grace_min,
      tardy_grace_min: data.tardy_grace_min ?? DEFAULT_SETTINGS.tardy_grace_min,
      shift_reminder_lead_min: data.shift_reminder_lead_min ?? DEFAULT_SETTINGS.shift_reminder_lead_min,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
