// The few Slack Web API calls the cash count reminders make, with the "Cash
// Count" app's bot token (Vault slack_cash_count_bot_token). Scopes: chat:write
// (post), channels:history (read the rules message and see whether anyone
// posted), users:read and users:read.email (match staff to Slack users).
//
// Every call is a form-encoded POST with `cache: "no-store"`: Next caches a route
// handler's GET fetches (see lib/supabase/admin.ts), and a cached "nobody has
// posted" would nudge people who already did.

const API = "https://slack.com/api/";

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
};

export type SlackUser = {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string; email?: string };
};

/** A call Slack answered: ok, or not ok with Slack's error code. */
export type SlackAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

/** Thrown when Slack did not answer (network, timeout, 5xx): whether a post went out is unknown. */
export class SlackUnreachable extends Error {}

async function call(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(API + method, {
      method: "POST",
      // Form-encoded: every Web API method takes it (several read methods ignore a JSON body).
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new SlackUnreachable(`${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500 || res.status === 429) throw new SlackUnreachable(`${method}: HTTP ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SlackUnreachable(`${method}: unreadable answer (HTTP ${res.status})`);
  }
}

function answer<T>(json: Record<string, unknown>, pick: (j: Record<string, unknown>) => T): SlackAnswer<T> {
  return json.ok === true ? { ok: true, value: pick(json) } : { ok: false, error: String(json.error ?? "unknown_error") };
}

export function slackClient(token: string) {
  return {
    async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackAnswer<string>> {
      const body: Record<string, unknown> = { channel, text, unfurl_links: false, unfurl_media: false };
      if (threadTs) body.thread_ts = threadTs;
      return answer(await call(token, "chat.postMessage", body), (j) => String(j.ts));
    },

    /** One message by its ts (the rules message), as it reads now, edits included. */
    async message(channel: string, ts: string): Promise<SlackAnswer<SlackMessage | null>> {
      const json = await call(token, "conversations.history", { channel, latest: ts, inclusive: true, limit: 1 });
      return answer(json, (j) => {
        const m = ((j.messages as SlackMessage[] | undefined) ?? [])[0];
        return m && m.ts === ts ? m : null;
      });
    },

    /** Channel messages after `oldest` (exclusive), newest first, one page. */
    async history(channel: string, oldest: string): Promise<SlackAnswer<SlackMessage[]>> {
      const json = await call(token, "conversations.history", { channel, oldest, limit: 100 });
      return answer(json, (j) => (j.messages as SlackMessage[] | undefined) ?? []);
    },

    /** The thread under `ts`: the parent first, then the replies. */
    async replies(channel: string, ts: string): Promise<SlackAnswer<SlackMessage[]>> {
      const json = await call(token, "conversations.replies", { channel, ts, limit: 200 });
      return answer(json, (j) => (j.messages as SlackMessage[] | undefined) ?? []);
    },

    async userByEmail(email: string): Promise<SlackAnswer<SlackUser>> {
      return answer(await call(token, "users.lookupByEmail", { email }), (j) => j.user as SlackUser);
    },

    /** Every member of the workspace (a small one: a few pages at most). */
    async users(): Promise<SlackAnswer<SlackUser[]>> {
      const all: SlackUser[] = [];
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const json = await call(token, "users.list", cursor ? { limit: 200, cursor } : { limit: 200 });
        if (json.ok !== true) return { ok: false, error: String(json.error ?? "unknown_error") };
        all.push(...((json.members as SlackUser[] | undefined) ?? []));
        cursor = String((json.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
        if (!cursor) break;
      }
      return { ok: true, value: all };
    },
  };
}

export type SlackClient = ReturnType<typeof slackClient>;

// Message subtypes that are a person posting. Everything else (channel_join,
// channel_topic, bot_message, message_changed, ...) is not someone posting
// counts. A photo upload arrives with files and no subtype, or "file_share".
const PERSON_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

/** True when a person (not a bot, not a join notice) wrote `m` after `afterTs`. */
export function isHumanPostAfter(m: SlackMessage, afterTs: string): boolean {
  if (!m.user || m.bot_id) return false;
  if (!PERSON_SUBTYPES.has(m.subtype)) return false;
  return Number(m.ts) > Number(afterTs);
}
