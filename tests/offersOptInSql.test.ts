// SQL-level tests for public.outreach_offers_opt_in (crm/007 + crm/009).
//
// tests/offersRoute.test.ts tests the route against the function's canned
// outcomes; this file tests the function itself, in a real Postgres. It runs
// only when CRM_SQL_TEST_DATABASE_URL points at a LOCAL server (localhost,
// 127.0.0.1, ::1 or a unix socket) and is skipped otherwise, so `npm test`
// needs no database. It never reads DATABASE_URL.
//
// Each run creates a throwaway database on that server, builds the few tables
// the function touches (stand-ins for bj-finance outreach/migrations 001-005
// and crm/003, reduced to the columns the function reads and writes), applies
// the real supabase/crm/007 and 009 files, and drops the database afterwards.
//
//   initdb -D /tmp/pg-crm -U postgres --auth=trust
//   pg_ctl -D /tmp/pg-crm -o "-p 55432 -k /tmp" -l /tmp/pg-crm.log start
//   CRM_SQL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npx vitest run tests/offersOptInSql.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.CRM_SQL_TEST_DATABASE_URL ?? "";

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

if (ADMIN_URL && !isLocal(ADMIN_URL)) {
  throw new Error("CRM_SQL_TEST_DATABASE_URL must point at a local server; refusing to run.");
}

const migration = (name: string) =>
  readFileSync(resolve(__dirname, "..", "supabase", "crm", name), "utf8");

// Stand-ins for the tables crm/007 needs, with the constraints that matter
// here: the opt_in_source vocabulary (bj-finance 005_consent_flags) and the
// suppression channel + partial unique email index (crm/003).
const SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE FUNCTION public.is_manager() RETURNS boolean LANGUAGE sql AS 'SELECT false';

CREATE TABLE public.outreach_prospects (
  id               bigint PRIMARY KEY,
  email            text,
  status           text NOT NULL DEFAULT 'raw',
  marketing_opt_in boolean NOT NULL DEFAULT false,
  opt_in_source    text CHECK (opt_in_source IN ('booked','explicit_yes','signup_form','import')),
  opt_in_at        timestamptz,
  last_outreach_at timestamptz,
  updated_at       timestamptz
);

CREATE TABLE public.outreach_suppression (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text,
  phone         text,
  channel       text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','phone','both')),
  reason        text,
  source        text,
  suppressed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outreach_suppression_email_uniq
  ON public.outreach_suppression (email) WHERE email IS NOT NULL;

CREATE TABLE public.outreach_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prospect_id bigint NOT NULL,
  event       text NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail      jsonb
);
`;

const FORM_DATE = "2026-06-01T12:00:00+00:00";
const EMAIL = "remy@example.com";

type Prospect = {
  status?: string;
  marketing_opt_in?: boolean;
  opt_in_source?: string | null;
  opt_in_at?: string | null;
  last_outreach_at?: string | null;
};

describe.skipIf(!ADMIN_URL)("outreach_offers_opt_in in Postgres", () => {
  const dbName = `crm_offers_sql_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let nextId = 1;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await sql.unsafe(SCHEMA);
    await sql.unsafe(migration("007_offers_opt_in.sql"));
  });

  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await sql`TRUNCATE public.outreach_offer_consents, public.outreach_suppression,
              public.outreach_events, public.outreach_prospects`;
  });

  async function prospect(p: Prospect = {}): Promise<number> {
    const id = nextId++;
    await sql`
      INSERT INTO public.outreach_prospects
        (id, email, status, marketing_opt_in, opt_in_source, opt_in_at, last_outreach_at)
      VALUES (${id}, ${EMAIL}, ${p.status ?? "sequenced"}, ${p.marketing_opt_in ?? false},
              ${p.opt_in_source ?? null}, ${p.opt_in_at ?? null},
              ${p.last_outreach_at === undefined ? "2026-09-01T00:00:00Z" : p.last_outreach_at})`;
    return id;
  }

  async function suppress(channel = "email", phone: string | null = null) {
    await sql`
      INSERT INTO public.outreach_suppression (email, phone, channel, reason, source)
      VALUES (${EMAIL}, ${phone}, ${channel}, 'unsubscribe', 'one_click')`;
  }

  async function press(id: number) {
    const [row] = await sql`
      SELECT public.outreach_offers_opt_in(${id}, 'I agree.', 'offers-v1', '203.0.113.9', 'probe') AS r`;
    return row.r as Record<string, unknown>;
  }

  const row = async (id: number) =>
    (await sql`SELECT * FROM public.outreach_prospects WHERE id = ${id}`)[0];
  const counts = async (id: number) => {
    const [c] = await sql`
      SELECT (SELECT count(*) FROM public.outreach_offer_consents WHERE prospect_id = ${id})::int AS consents,
             (SELECT count(*) FROM public.outreach_events WHERE prospect_id = ${id})::int AS events,
             (SELECT count(*) FROM public.outreach_suppression WHERE email = ${EMAIL})::int AS email_supp`;
    return c;
  };

  // The function's security posture: definer/invoker, search_path, and who
  // may EXECUTE it (grantee 0 in the ACL is PUBLIC).
  const FN = "public.outreach_offers_opt_in(bigint, text, text, text, text)";
  const functionFacts = async () =>
    (await sql`
      SELECT p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
        FROM pg_proc p
       WHERE p.oid = ${FN}::regprocedure`)[0];

  describe("crm/007 alone (the gap)", () => {
    it("rewrote a signup_form opt-in to explicit_yes with a second consent", async () => {
      const id = await prospect({ marketing_opt_in: true, opt_in_source: "signup_form", opt_in_at: FORM_DATE });
      const r = await press(id);
      expect(r).toMatchObject({ opted_in: true, already: false });
      expect((await row(id)).opt_in_source).toBe("explicit_yes");
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
    });
  });

  describe("after crm/009", () => {
    beforeAll(async () => {
      await sql.unsafe(migration("009_offers_opt_in_signup_form.sql"));
    });

    it("treats a signup_form opt-in as already explicit and writes nothing", async () => {
      const id = await prospect({ marketing_opt_in: true, opt_in_source: "signup_form", opt_in_at: FORM_DATE });
      const r = await press(id);

      expect(r).toMatchObject({ opted_in: false, already: true, refused: null, lifted: false });
      expect(new Date(r.opted_in_at as string).toISOString()).toBe(new Date(FORM_DATE).toISOString());
      const p = await row(id);
      expect(p.opt_in_source).toBe("signup_form");
      expect(p.opt_in_at.toISOString()).toBe(new Date(FORM_DATE).toISOString());
      expect(await counts(id)).toEqual({ consents: 0, events: 0, email_supp: 0 });
    });

    // opt_in_at IS NULL (an import, or a form that recorded no date). The
    // already branch returns opt_in_at as the agreement date, and there is
    // none, so this is NOT a repeat: it is written as a real explicit_yes with
    // a consent row and opt_in_at = now(). The confirmation then shows a true
    // date with stored proof, not a fabricated today's date. The rule is about
    // the date, not the source, so an undated explicit_yes row goes the same way.
    it.each(["signup_form", "explicit_yes"])(
      "upgrades an UNDATED %s opt-in instead of returning a dateless already",
      async (source) => {
        const before = Date.now();
        const id = await prospect({ marketing_opt_in: true, opt_in_source: source, opt_in_at: null });
        const r = await press(id);

        expect(r).toMatchObject({ opted_in: true, already: false, refused: null, lifted: false });
        expect(new Date(r.opted_in_at as string).getTime()).toBeGreaterThanOrEqual(before);
        const p = await row(id);
        expect(p).toMatchObject({ marketing_opt_in: true, opt_in_source: "explicit_yes" });
        // The date the page shows is the date stored on the prospect.
        expect(p.opt_in_at.toISOString()).toBe(new Date(r.opted_in_at as string).toISOString());
        expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
      },
    );

    it("records a signup_form person's yes after an unsubscribe as a new explicit yes, and lifts it", async () => {
      const id = await prospect({
        status: "suppressed", marketing_opt_in: true, opt_in_source: "signup_form", opt_in_at: FORM_DATE,
      });
      await suppress();
      const r = await press(id);

      expect(r).toMatchObject({ opted_in: true, already: false, lifted: true });
      const p = await row(id);
      expect(p).toMatchObject({ marketing_opt_in: true, opt_in_source: "explicit_yes", status: "sequenced" });
      expect(p.opt_in_at.getTime()).toBeGreaterThan(new Date(FORM_DATE).getTime());
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });

      const [consent] = await sql`SELECT * FROM public.outreach_offer_consents WHERE prospect_id = ${id}`;
      // The press is now the basis for mailing them, so its proof is on the row.
      expect(consent).toMatchObject({
        email: EMAIL, method: "offers_button", consent_text: "I agree.",
        page_version: "offers-v1", ip: "203.0.113.9", user_agent: "probe",
      });
      expect(consent.lifted_suppression).toMatchObject({
        reason: "unsubscribe", channel: "email", phone_kept: false,
        status_before: "suppressed", status_after: "sequenced",
      });
      const [event] = await sql`SELECT * FROM public.outreach_events WHERE prospect_id = ${id}`;
      expect(event.event).toBe("opted_in");
      expect(event.detail).toMatchObject({ source: "explicit_yes", via: "offers_button", consent_id: Number(consent.id) });
    });

    it("lifts a signup_form person with a suppression row but a status that was never flipped", async () => {
      const id = await prospect({ marketing_opt_in: true, opt_in_source: "signup_form", opt_in_at: FORM_DATE });
      await suppress();
      const r = await press(id);

      expect(r).toMatchObject({ opted_in: true, already: false, lifted: true });
      expect((await row(id)).opt_in_source).toBe("explicit_yes");
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
    });

    it("lifts a signup_form person marked suppressed with no suppression row", async () => {
      const id = await prospect({
        status: "suppressed", marketing_opt_in: true, opt_in_source: "signup_form",
        opt_in_at: FORM_DATE, last_outreach_at: null,
      });
      const r = await press(id);

      expect(r).toMatchObject({ opted_in: true, lifted: true });
      expect(await row(id)).toMatchObject({ opt_in_source: "explicit_yes", status: "raw" });
    });

    it("keeps the phone half of a call-desk do-not-call-or-email for a signup_form person", async () => {
      const id = await prospect({ marketing_opt_in: true, opt_in_source: "signup_form", opt_in_at: FORM_DATE });
      await suppress("both", "+12155550100");
      const r = await press(id);

      expect(r).toMatchObject({ opted_in: true, lifted: true });
      const supp = await sql`SELECT email, phone, channel FROM public.outreach_suppression`;
      expect(supp).toEqual([{ email: null, phone: "+12155550100", channel: "phone" }]);
    });

    // The explicit set is exactly explicit_yes and signup_form (EXPLICIT_OPT_IN_SOURCES
    // in lib/emailCampaignsPrototype/model.ts); every other source, and a flag
    // with no source at all, is upgraded.
    it.each(["booked", "import", null])("still upgrades an opt_in_source=%s opt-in to explicit_yes with a consent row", async (source) => {
      const id = await prospect({ marketing_opt_in: true, opt_in_source: source, opt_in_at: FORM_DATE });
      expect(await press(id)).toMatchObject({ opted_in: true, already: false, lifted: false });
      expect((await row(id)).opt_in_source).toBe("explicit_yes");
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
    });

    it("still opts in someone with no opt-in, and a second press is a repeat", async () => {
      const id = await prospect();
      expect(await press(id)).toMatchObject({ opted_in: true, already: false });
      expect(await press(id)).toMatchObject({ opted_in: false, already: true });
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
    });

    // Dated, so the flag is the only thing standing between this row and
    // "already": an undated row would be upgraded by the date rule alone.
    it("does not count a dated signup_form source whose flag is off as an opt-in", async () => {
      const id = await prospect({ marketing_opt_in: false, opt_in_source: "signup_form", opt_in_at: FORM_DATE });
      expect(await press(id)).toMatchObject({ opted_in: true, already: false });
      expect(await row(id)).toMatchObject({ marketing_opt_in: true, opt_in_source: "explicit_yes" });
      expect(await counts(id)).toEqual({ consents: 1, events: 1, email_supp: 0 });
    });

    it("still refuses a dead row", async () => {
      const id = await prospect({ status: "dead", marketing_opt_in: true, opt_in_source: "signup_form" });
      expect(await press(id)).toMatchObject({ opted_in: false, already: false, refused: "dead" });
      expect(await counts(id)).toEqual({ consents: 0, events: 0, email_supp: 0 });
    });

    it("keeps SECURITY INVOKER, search_path and service_role-only EXECUTE", async () => {
      expect(await functionFacts()).toEqual({
        prosecdef: false, proconfig: ["search_path=public"],
        anon: false, authenticated: false, service_role: true, public: false,
      });
    });

    // CREATE OR REPLACE keeps whatever ACL the function already has, so the
    // test above passes on 007's grants alone. This one scrambles the ACL
    // first: only 009's own REVOKE and GRANT can put it back.
    it("leaves EXECUTE service_role-only whatever ACL the function had before", async () => {
      await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC, anon, authenticated;
                        REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role;`);
      await sql.unsafe(migration("009_offers_opt_in_signup_form.sql"));

      expect(await functionFacts()).toMatchObject({
        anon: false, authenticated: false, service_role: true, public: false,
      });
    });
  });
});
