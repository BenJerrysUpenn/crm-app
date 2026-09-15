// Runs staffing records: creates them from a parsed form, executes the
// automatic steps in order, applies the side effects of marking a manual
// step done, and closes the record when every step is done or skipped.
//
// Worker steps (Square, Slack, QuickBooks, Google) are not run here: the app
// queues them and the bj-finance onboarding worker performs them as the
// manager and writes the result back. A manager can also do one by hand and
// mark it done here.
//
// Every write goes through the service-role client after the route has
// already checked the caller is a manager. Reads through that client are
// no-store (see lib/supabase/admin.ts), so a record never comes back stale.
//
// No handler here deletes a profile or an auth user. Offboarding bans the
// login and revokes sessions; time_entries cascade from profiles, so a
// delete would take the person's payroll hours with it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteTeamMember } from "@/lib/team";
import type {
  Lifecycle,
  LifecycleKind,
  LifecycleStep,
  LifecycleWithSteps,
  Profile,
} from "@/lib/types";
import {
  inviteSteps,
  offboardingSteps,
  type InviteForm,
  type OffboardingForm,
  type StepSpec,
} from "./catalogue";

// A century. Supabase's ban_duration is a Go duration string.
const BAN_FOREVER = "876000h";

export type Actor = { me: Profile; origin: string };

type Outcome = { ok: true; result: string } | { ok: false; result: string };

// ---------------------------------------------------------------------------
// Load / create
// ---------------------------------------------------------------------------

export async function loadLifecycle(
  admin: SupabaseClient,
  id: number,
): Promise<LifecycleWithSteps | null> {
  const { data: rec } = await admin
    .from("staff_lifecycle")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!rec) return null;
  const { data: steps } = await admin
    .from("staff_lifecycle_steps")
    .select("*")
    .eq("lifecycle_id", id)
    .order("seq", { ascending: true });
  return { ...(rec as Lifecycle), steps: (steps as LifecycleStep[]) ?? [] };
}

export async function listLifecycles(
  client: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<LifecycleWithSteps[]> {
  const { data: recs } = await client
    .from("staff_lifecycle")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);
  const rows = (recs as Lifecycle[]) ?? [];
  if (!rows.length) return [];
  const { data: steps } = await client
    .from("staff_lifecycle_steps")
    .select("*")
    .in(
      "lifecycle_id",
      rows.map((r) => r.id),
    )
    .order("seq", { ascending: true });
  const byId = new Map<number, LifecycleStep[]>();
  for (const s of (steps as LifecycleStep[]) ?? []) {
    const arr = byId.get(s.lifecycle_id) ?? [];
    arr.push(s);
    byId.set(s.lifecycle_id, arr);
  }
  return rows.map((r) => ({ ...r, steps: byId.get(r.id) ?? [] }));
}

export async function createLifecycle(
  admin: SupabaseClient,
  args: {
    kind: LifecycleKind;
    form: InviteForm | OffboardingForm;
    employee_id: string | null;
    created_by: string;
  },
): Promise<{ id: number } | { error: string }> {
  const specs: StepSpec[] =
    args.kind === "offboarding"
      ? offboardingSteps(args.form as OffboardingForm)
      : inviteSteps(args.form as InviteForm, args.kind);

  const { data: rec, error } = await admin
    .from("staff_lifecycle")
    .insert({
      kind: args.kind,
      employee_id: args.employee_id,
      form: args.form,
      created_by: args.created_by,
    })
    .select("id")
    .single();
  if (error || !rec) return { error: error?.message ?? "Could not create the record" };

  const { error: sErr } = await admin.from("staff_lifecycle_steps").insert(
    specs.map((s, i) => ({
      lifecycle_id: rec.id,
      key: s.key,
      seq: i + 1,
      mode: s.mode,
      label: s.label,
      detail: s.detail,
      system: s.system ?? null,
      action: s.action ?? null,
      payload: s.payload ?? {},
    })),
  );
  if (sErr) return { error: sErr.message };
  return { id: rec.id as number };
}

// ---------------------------------------------------------------------------
// Automatic steps
// ---------------------------------------------------------------------------

type Ctx = {
  admin: SupabaseClient;
  rec: LifecycleWithSteps;
  step: LifecycleStep;
  actor: Actor;
};

const handlers: Record<string, (c: Ctx) => Promise<Outcome>> = {
  // -- invite / re-invite ------------------------------------------------
  async withers_time_invite({ admin, rec, actor }) {
    const f = rec.form as unknown as InviteForm;
    const r = await inviteTeamMember({
      email: f.email,
      full_name: f.legal_name,
      role: f.role,
      phone: f.phone,
      hourly_rate: f.pay_rate,
      preferred_name: f.preferred_name,
      start_date: f.start_date,
      invitedBy: actor.me.full_name,
      origin: actor.origin,
    });
    if (!r.ok) return { ok: false, result: r.error };
    await admin.from("staff_lifecycle").update({ employee_id: r.user_id }).eq("id", rec.id);
    rec.employee_id = r.user_id;
    return {
      ok: true,
      result: `Invited ${r.email} (delivery: ${r.delivery}); profile ${r.user_id}`,
    };
  },

  async fob_assign({ admin, rec }) {
    const f = rec.form as unknown as InviteForm;
    if (!rec.employee_id) return { ok: false, result: "No Withers-time profile yet" };
    if (!f.fob_card_id) return { ok: false, result: "No fob card id on the form" };
    return assignFob(admin, rec.employee_id, f.fob_card_id);
  },

  // -- offboarding -------------------------------------------------------
  async auth_ban({ admin, rec }) {
    if (!rec.employee_id) return { ok: false, result: "No employee on the record" };
    const { error } = await admin.auth.admin.updateUserById(rec.employee_id, {
      ban_duration: BAN_FOREVER,
    });
    if (error) return { ok: false, result: error.message };
    return { ok: true, result: "Login banned; account and time entries kept" };
  },

  async sessions_revoke({ admin, rec }) {
    if (!rec.employee_id) return { ok: false, result: "No employee on the record" };
    const { data, error } = await admin.rpc("revoke_user_sessions", { uid: rec.employee_id });
    if (error) return { ok: false, result: `revoke_user_sessions: ${error.message}` };
    return { ok: true, result: `${Number(data ?? 0)} session(s) removed` };
  },

  async role_employee({ admin, rec }) {
    if (!rec.employee_id) return { ok: false, result: "No employee on the record" };
    const { error } = await admin
      .from("profiles")
      .update({ role: "employee" })
      .eq("id", rec.employee_id);
    if (error) return { ok: false, result: error.message };
    return { ok: true, result: "Role set to employee" };
  },

  async mark_inactive({ admin, rec }) {
    if (!rec.employee_id) return { ok: false, result: "No employee on the record" };
    const f = rec.form as unknown as OffboardingForm;
    const { error } = await admin
      .from("profiles")
      .update({ active: false, last_day: f.last_day })
      .eq("id", rec.employee_id);
    if (error) return { ok: false, result: error.message };
    return { ok: true, result: `Inactive; last day ${f.last_day}` };
  },

  async fob_unassign({ admin, rec }) {
    if (!rec.employee_id) return { ok: false, result: "No employee on the record" };
    const { data: cards, error: rErr } = await admin
      .from("staff_cards")
      .select("card_id")
      .eq("employee_id", rec.employee_id);
    if (rErr) return { ok: false, result: rErr.message };
    const ids = (cards ?? []).map((c) => c.card_id as string);
    if (!ids.length) return { ok: true, result: "No fob was assigned" };
    const { error } = await admin.from("staff_cards").delete().eq("employee_id", rec.employee_id);
    if (error) return { ok: false, result: error.message };
    return { ok: true, result: `Unassigned fob ${ids.join(", ")}` };
  },
};

async function assignFob(
  admin: SupabaseClient,
  employee_id: string,
  card_id: string,
): Promise<Outcome> {
  const { data: existing } = await admin
    .from("staff_cards")
    .select("employee_id")
    .eq("card_id", card_id)
    .maybeSingle();
  if (existing && existing.employee_id !== employee_id)
    return { ok: false, result: `Card ${card_id} is already assigned to someone else` };
  if (existing) return { ok: true, result: `Card ${card_id} was already assigned to this person` };
  const { error } = await admin.from("staff_cards").insert({ card_id, employee_id });
  if (error) return { ok: false, result: error.message };
  return { ok: true, result: `Card ${card_id} assigned` };
}

async function setStep(
  admin: SupabaseClient,
  step: LifecycleStep,
  patch: Partial<LifecycleStep>,
) {
  await admin.from("staff_lifecycle_steps").update(patch).eq("id", step.id);
}

// Runs every pending automatic step in order and stops at the first failure,
// so an offboarding never marks someone inactive while their login is still
// open. Returns the reloaded record.
export async function runAutoSteps(
  id: number,
  actor: Actor,
): Promise<LifecycleWithSteps | null> {
  const admin = createAdminClient();
  const rec = await loadLifecycle(admin, id);
  if (!rec || rec.status !== "open") return rec;

  for (const step of rec.steps) {
    if (step.mode !== "auto") continue;
    if (step.status !== "pending" && step.status !== "failed") continue;
    const handler = handlers[step.key];
    let out: Outcome;
    if (!handler) {
      out = { ok: false, result: `No handler for step ${step.key}` };
    } else {
      try {
        out = await handler({ admin, rec, step, actor });
      } catch (e) {
        out = { ok: false, result: e instanceof Error ? e.message : String(e) };
      }
    }
    await setStep(admin, step, {
      status: out.ok ? "done" : "failed",
      result: out.result,
      completed_by: out.ok ? actor.me.id : null,
      completed_at: out.ok ? new Date().toISOString() : null,
    });
    if (!out.ok) break;
  }
  await closeIfComplete(admin, id);
  return loadLifecycle(admin, id);
}

// ---------------------------------------------------------------------------
// Manual steps
// ---------------------------------------------------------------------------

export type ManualInput = {
  note?: string | null;
  skipped?: boolean;
  fob_card_id?: string | null;
  qbo_employee_id?: string | null;
};

export async function completeManualStep(
  id: number,
  key: string,
  input: ManualInput,
  actor: Actor,
): Promise<{ rec: LifecycleWithSteps | null; error?: string }> {
  const admin = createAdminClient();
  const rec = await loadLifecycle(admin, id);
  if (!rec) return { rec: null, error: "No such record" };
  const step = rec.steps.find((s) => s.key === key);
  if (!step) return { rec, error: "No such step" };
  if (step.mode === "auto") return { rec, error: "That step runs automatically; use Run" };

  let result = (input.note ?? "").trim() || null;

  if (!input.skipped) {
    // Side effects for the steps that carry data back into the app.
    if (key === "fob_assign") {
      const card = (input.fob_card_id ?? "").trim();
      if (!card) return { rec, error: "Enter the fob card id first" };
      if (!rec.employee_id) return { rec, error: "No Withers-time profile yet" };
      const out = await assignFob(admin, rec.employee_id, card);
      if (!out.ok) return { rec, error: out.result };
      result = result ? `${out.result}. ${result}` : out.result;
    }
    if (key === "qbo_create_employee" && rec.employee_id) {
      const eeid = (input.qbo_employee_id ?? "").trim();
      if (eeid) {
        const { error } = await admin
          .from("profiles")
          .update({ qbo_employee_id: eeid })
          .eq("id", rec.employee_id);
        if (error) return { rec, error: error.message };
        result = result ? `eeid ${eeid}. ${result}` : `eeid ${eeid}`;
      }
    }
    if (key === "workforce_completed" && rec.employee_id) {
      const { error } = await admin
        .from("profiles")
        .update({ has_workforce: true })
        .eq("id", rec.employee_id);
      if (error) return { rec, error: error.message };
    }
  }

  await setStep(admin, step, {
    status: input.skipped ? "skipped" : "done",
    result,
    completed_by: actor.me.id,
    completed_at: new Date().toISOString(),
  });
  await closeIfComplete(admin, id);
  return { rec: await loadLifecycle(admin, id) };
}

export async function reopenStep(
  id: number,
  key: string,
): Promise<{ rec: LifecycleWithSteps | null; error?: string }> {
  const admin = createAdminClient();
  const rec = await loadLifecycle(admin, id);
  if (!rec) return { rec: null, error: "No such record" };
  const step = rec.steps.find((s) => s.key === key);
  if (!step) return { rec, error: "No such step" };
  if (step.mode === "auto") return { rec, error: "Automatic steps are re-run, not reopened" };
  await setStep(admin, step, {
    status: "pending",
    result: null,
    completed_by: null,
    completed_at: null,
    claimed_at: null,
  });
  await admin
    .from("staff_lifecycle")
    .update({ status: "open", completed_at: null })
    .eq("id", id)
    .eq("status", "done");
  return { rec: await loadLifecycle(admin, id) };
}

export async function setLifecycleStatus(
  id: number,
  status: "open" | "cancelled",
): Promise<LifecycleWithSteps | null> {
  const admin = createAdminClient();
  await admin
    .from("staff_lifecycle")
    .update({ status, completed_at: null })
    .eq("id", id);
  return loadLifecycle(admin, id);
}

async function closeIfComplete(admin: SupabaseClient, id: number) {
  const rec = await loadLifecycle(admin, id);
  if (!rec || rec.status !== "open") return;
  const allDone = rec.steps.every((s) => s.status === "done" || s.status === "skipped");
  if (!allDone) return;
  await admin
    .from("staff_lifecycle")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", id);
}
