// The few Slack Web API calls the cake order reminders make, with the "Cake
// Orders" app's bot token (Vault slack_cake_orders_bot_token). Scopes:
// chat:write (post), channels:history (see replies and the next channel
// message), reactions:read (see a packed reaction), users:read and
// users:read.email (match staff to Slack users).
//
// The same shape as the cash count's client (lib/cashCount/slack.ts), plus
// reactions.get. Every call is a form-encoded POST with `cache: "no-store"`,
// so a cached "not packed" can never nudge people who already packed it.

import type { SlackAnswer, SlackMessage, SlackUser } from "../cashCount/slack";
import type { SlackReaction } from "./plan";

export type { SlackAnswer, SlackMessage, SlackUser };

const API = "https://slack.com/api/";

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

    /** Channel messages after `oldest` (exclusive), newest first, one page. */
    async history(channel: string, oldest: string): Promise<SlackAnswer<SlackMessage[]>> {
      const json = await call(token, "conversations.history", { channel, oldest, limit: 200 });
      return answer(json, (j) => (j.messages as SlackMessage[] | undefined) ?? []);
    },

    /** The thread under `ts`: the parent first, then the replies. */
    async replies(channel: string, ts: string): Promise<SlackAnswer<SlackMessage[]>> {
      const json = await call(token, "conversations.replies", { channel, ts, limit: 200 });
      return answer(json, (j) => (j.messages as SlackMessage[] | undefined) ?? []);
    },

    /** The reactions on one message (all of them, not just the first users of each). */
    async reactions(channel: string, ts: string): Promise<SlackAnswer<SlackReaction[]>> {
      const json = await call(token, "reactions.get", { channel, timestamp: ts, full: true });
      return answer(json, (j) => ((j.message as { reactions?: SlackReaction[] } | undefined)?.reactions ?? []));
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
