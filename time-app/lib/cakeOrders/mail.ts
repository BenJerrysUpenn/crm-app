// The mailbox the cake order reminders read Olo's order emails from. Olo
// sends every order to the order address (a Google group); the group forwards
// to the owners' own mailboxes, and the job reads one of them over IMAP with
// the Gmail app password already in Supabase Vault (gmail_sender_address,
// gmail_app_password: the bj-finance mailbox, cli.ts). No new credential.
//
// READ ONLY. The mailbox is opened with EXAMINE, never SELECT, and bodies are
// fetched with BODY.PEEK, so nothing is marked read, moved or changed.
//
// No library: a TLS socket to imap.gmail.com:993 and five commands (LOGIN,
// LIST, EXAMINE, UID SEARCH with Gmail's X-GM-RAW, UID FETCH, then LOGOUT).
// The box installs only tsx and postgres for crm-app (Software-Factory
// droplet/crmcli.sh), and the coverage reminder sends Gmail the same way
// (lib/gmailSend.ts). It searches "All Mail" (the mailbox flagged \All), so
// a filter that skips the inbox does not hide an order.
//
// The password goes to the server in the LOGIN command and nowhere else: it
// is never in an error, a log line or a command line. Every failure throws
// with the server's own words, which never echo it.

import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

export const IMAP_HOST = "imap.gmail.com";
export const IMAP_PORT = 993;
/** One whole session (connect to logout) may take this long. */
export const MAIL_TIMEOUT_MS = 30_000;
/** At most this many of the newest matching emails are read on a tick. */
export const MAX_MESSAGES = 50;
/** An email is read up to this many bytes; an order email is far smaller, and attachments are not needed. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** One email as the mailbox holds it. */
export type MailMessage = {
  uid: number;
  /** When the mailbox received it (IMAP INTERNALDATE), ISO. */
  receivedAt: string;
  /** The raw RFC 5322 message, up to MAX_MESSAGE_BYTES, as latin1 so every byte survives. */
  raw: string;
};

export type MailReader = {
  /** The emails matching a Gmail search, oldest first. Throws when the mailbox cannot be read. */
  search(gmailQuery: string): Promise<MailMessage[]>;
};

export type ImapOptions = {
  user: string;
  password: string;
  /** Opens the connection; tests hand a plain socket to a fake server. */
  connect?: () => Duplex;
  timeoutMs?: number;
};

/** An IMAP string: quoted, with \ and " escaped. CR and LF cannot be in one and are refused. */
export function imapQuote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error("IMAP string with a line break");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One untagged response: its text with each literal's place marked, and the literals. */
type Untagged = { line: string; literals: Buffer[] };

/** Reads IMAP responses off a socket: lines, with {n} literals inside them. */
class ImapReader {
  private buf = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private ended: Error | null = null;
  constructor(socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on("end", () => this.fail(new Error("the mail server closed the connection")));
    socket.on("close", () => this.fail(new Error("the mail server closed the connection")));
    socket.on("error", (e: Error) => this.fail(e));
  }
  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }
  fail(e: Error) {
    if (!this.ended) this.ended = e;
    this.wake();
  }
  private async more(): Promise<void> {
    if (this.ended) throw this.ended;
    await new Promise<void>((resolve) => (this.waiting = resolve));
  }
  private async line(): Promise<string> {
    for (;;) {
      const at = this.buf.indexOf("\r\n");
      if (at >= 0) {
        const line = this.buf.subarray(0, at).toString("latin1");
        this.buf = this.buf.subarray(at + 2);
        return line;
      }
      await this.more();
    }
  }
  private async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
  /** One response: a line, and for each {n} it ends with, the n bytes and the rest of the line. */
  async response(): Promise<Untagged> {
    let line = await this.line();
    const literals: Buffer[] = [];
    for (;;) {
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) return { line, literals };
      literals.push(await this.bytes(Number(m[1])));
      line = `${line.slice(0, m.index)}\u0000${await this.line()}`;
    }
  }
}

/** IMAP over TLS to Gmail, read only. See the top of this file. */
export function imapMailbox(opts: ImapOptions): MailReader {
  const open = opts.connect ?? (() => tlsConnect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST }));
  const timeoutMs = opts.timeoutMs ?? MAIL_TIMEOUT_MS;
  return {
    async search(gmailQuery) {
      const socket = open();
      const reader = new ImapReader(socket);
      const timer = setTimeout(() => {
        reader.fail(new Error(`the mail server did not answer within ${Math.round(timeoutMs / 1000)}s`));
        socket.destroy();
      }, timeoutMs);
      let n = 0;
      /** Send one command; resolve with its untagged responses once it ends OK, throw on NO or BAD. */
      const run = async (command: string, what: string): Promise<Untagged[]> => {
        const tag = `C${++n}`;
        socket.write(`${tag} ${command}\r\n`);
        const untagged: Untagged[] = [];
        for (;;) {
          const r = await reader.response();
          if (r.line.startsWith(`${tag} `)) {
            const status = r.line.slice(tag.length + 1);
            if (!/^OK\b/i.test(status)) throw new Error(`IMAP ${what} failed: ${status.slice(0, 200)}`);
            return untagged;
          }
          if (r.line.startsWith("+")) throw new Error(`IMAP ${what}: the server asked for more input`);
          untagged.push(r);
        }
      };
      try {
        const greeting = await reader.response();
        if (!/^\* (OK|PREAUTH)\b/i.test(greeting.line)) throw new Error(`IMAP greeting: ${greeting.line.slice(0, 200)}`);
        await run(`LOGIN ${imapQuote(opts.user)} ${imapQuote(opts.password)}`, "login");

        const listed = await run('LIST "" "*"', "list");
        const all = listed.map((r) => /^\* LIST \(([^)]*)\) \S+ (.+)$/i.exec(r.line)).find((m) => m && /\\All\b/i.test(m[1]));
        const mailbox = all ? all[2] : '"INBOX"';
        await run(`EXAMINE ${mailbox}`, "examine");

        const found = await run(`UID SEARCH X-GM-RAW ${imapQuote(gmailQuery)}`, "search");
        const uids = found
          .flatMap((r) => (/^\* SEARCH\b(.*)$/i.exec(r.line)?.[1] ?? "").trim().split(/\s+/))
          .filter(Boolean)
          .map(Number)
          .filter((u) => Number.isInteger(u) && u > 0)
          .sort((a, b) => a - b)
          .slice(-MAX_MESSAGES);

        const messages: MailMessage[] = [];
        if (uids.length) {
          const fetched = await run(`UID FETCH ${uids.join(",")} (UID INTERNALDATE BODY.PEEK[]<0.${MAX_MESSAGE_BYTES}>)`, "fetch");
          for (const r of fetched) {
            if (!/^\* \d+ FETCH\b/i.test(r.line)) continue;
            const uid = Number(/\bUID (\d+)/i.exec(r.line)?.[1]);
            const date = /\bINTERNALDATE "([^"]+)"/i.exec(r.line)?.[1];
            const raw = r.literals[0];
            if (!uid || !date || !raw) continue;
            messages.push({ uid, receivedAt: imapDate(date), raw: raw.toString("latin1") });
          }
        }
        await run("LOGOUT", "logout").catch(() => {
          /* the server may close as it says BYE; what was read stands */
        });
        return messages.sort((a, b) => a.uid - b.uid);
      } finally {
        clearTimeout(timer);
        socket.destroy();
      }
    },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An IMAP date-time ("03-Nov-2026 15:40:07 -0500") as an ISO instant. */
export function imapDate(s: string): string {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new Error(`unreadable IMAP date: ${s}`);
  const month = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  if (month < 0) throw new Error(`unreadable IMAP date: ${s}`);
  const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
  return new Date(utc).toISOString();
}

// ---- headers ---------------------------------------------------------------------

/** A header of a raw message, unfolded and with RFC 2047 encoded words decoded, or "" when it has none. */
export function headerOf(raw: string, name: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end >= 0 ? raw.slice(0, end) : raw).replace(/\r?\n[ \t]+/g, " ");
  const wanted = name.toLowerCase();
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) return decodeWords(line.slice(colon + 1).trim());
  }
  return "";
}

/** RFC 2047: =?charset?B|Q?text?= words, UTF-8 or Latin-1; others are left as they are. */
function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (word, charset: string, enc: string, text: string) => {
      const cs = charset.toLowerCase().replace(/\*.*$/, "");
      if (!["utf-8", "utf8", "iso-8859-1", "latin1", "us-ascii"].includes(cs)) return word;
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return bytes.toString(cs.startsWith("utf") ? "utf8" : "latin1");
    });
}
