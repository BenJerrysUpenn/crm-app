// The mailbox reader (lib/cakeOrders/mail.ts) against a fake IMAP server on
// a local socket, speaking Gmail's dialect as RFC 3501 and Gmail's IMAP
// extensions describe it. The stories:
//   * it logs in, finds All Mail by its \All flag, opens it READ ONLY
//     (EXAMINE), searches with X-GM-RAW and fetches with BODY.PEEK, so
//     nothing is marked read;
//   * each email comes back whole (the literal), with the mailbox's own
//     received time;
//   * a refused login throws with the server's words and never the password;
//   * no match means no fetch.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Server, type Socket } from "node:net";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Mail from "./mail.ts";

const mail = await loadAppModule<typeof Mail>("lib/cakeOrders/mail.ts");
const { headerOf, imapDate, imapMailbox, imapQuote } = mail;

const PASSWORD = "abcd efgh ijkl mnop";
const EMAIL_1 = "From: Someone <a@example.test>\r\nSubject: =?UTF-8?B?Q2FrZSDwn46C?=\r\nMessage-ID: <one@example.test>\r\n\r\nFirst body\r\n";
const EMAIL_2 = "From: b@example.test\r\nSubject: Second\r\n  folded\r\n\r\nSecond body, with a } brace\r\n";

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

type Fake = { commands: string[]; port: number };

/** A scripted Gmail: `loginOk` decides LOGIN; `uids` is what SEARCH finds. */
async function fakeGmail(opts: { loginOk?: boolean; uids?: number[] } = {}): Promise<Fake> {
  const fake: Fake = { commands: [], port: 0 };
  server = createServer((sock: Socket) => {
    sock.write("* OK Gimap ready\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let at;
      while ((at = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        fake.commands.push(cmd);
        if (cmd.startsWith("LOGIN")) {
          sock.write(opts.loginOk === false ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n` : `${tag} OK authenticated\r\n`);
        } else if (cmd.startsWith("LIST")) {
          sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n');
          sock.write(`${tag} OK Success\r\n`);
        } else if (cmd.startsWith("EXAMINE")) {
          sock.write(`* 2 EXISTS\r\n${tag} OK [READ-ONLY] Success\r\n`);
        } else if (cmd.startsWith("UID SEARCH")) {
          sock.write(`* SEARCH${(opts.uids ?? [41, 42]).map((u) => ` ${u}`).join("")}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (cmd.startsWith("UID FETCH")) {
          const one = Buffer.from(EMAIL_1, "latin1");
          const two = Buffer.from(EMAIL_2, "latin1");
          sock.write(`* 1 FETCH (UID 41 INTERNALDATE "03-Nov-2026 23:10:07 -0500" BODY[]<0> {${one.length}}\r\n`);
          sock.write(one);
          sock.write(")\r\n");
          sock.write(`* 2 FETCH (UID 42 INTERNALDATE " 4-Nov-2026 09:02:00 +0000" BODY[]<0> {${two.length}}\r\n`);
          sock.write(two);
          sock.write(`)\r\n${tag} OK Success\r\n`);
        } else if (cmd.startsWith("LOGOUT")) {
          sock.write(`* BYE LOGOUT Requested\r\n${tag} OK 73 good day\r\n`);
          sock.end();
        } else {
          sock.write(`${tag} BAD unexpected\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  fake.port = (server!.address() as { port: number }).port;
  return fake;
}

const reader = (fake: Fake) => imapMailbox({ user: "owner@example.test", password: PASSWORD, connect: () => connect(fake.port, "127.0.0.1") });

test("logs in, opens All Mail read only, searches with X-GM-RAW and peeks at each email whole", async () => {
  const fake = await fakeGmail();
  const got = await reader(fake).search("to:orders@example.test newer_than:2d");
  assert.deepEqual(got, [
    { uid: 41, receivedAt: "2026-11-04T04:10:07.000Z", raw: EMAIL_1 },
    { uid: 42, receivedAt: "2026-11-04T09:02:00.000Z", raw: EMAIL_2 },
  ]);
  assert.deepEqual(fake.commands, [
    `LOGIN "owner@example.test" "${PASSWORD}"`,
    'LIST "" "*"',
    'EXAMINE "[Gmail]/All Mail"',
    'UID SEARCH X-GM-RAW "to:orders@example.test newer_than:2d"',
    "UID FETCH 41,42 (UID INTERNALDATE BODY.PEEK[]<0.262144>)",
    "LOGOUT",
  ]);
  assert.ok(!fake.commands.some((c) => /^(SELECT|STORE|COPY|MOVE|EXPUNGE)\b/.test(c)), "nothing that changes the mailbox");
});

test("no match: no fetch", async () => {
  const fake = await fakeGmail({ uids: [] });
  assert.deepEqual(await reader(fake).search("to:orders@example.test newer_than:2d"), []);
  assert.ok(!fake.commands.some((c) => c.startsWith("UID FETCH")));
});

test("a refused login throws with the server's words, never the password", async () => {
  const fake = await fakeGmail({ loginOk: false });
  await assert.rejects(reader(fake).search("x"), (e: Error) => {
    assert.match(e.message, /^IMAP login failed: NO \[AUTHENTICATIONFAILED\] Invalid credentials/);
    assert.ok(!e.message.includes(PASSWORD));
    return true;
  });
});

test("a server that never answers times out", async () => {
  server = createServer(() => {
    /* silent */
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const r = imapMailbox({ user: "u", password: "p", connect: () => connect(port, "127.0.0.1"), timeoutMs: 200 });
  await assert.rejects(r.search("x"), /did not answer/);
});

test("IMAP strings are quoted and escaped; a line break is refused", () => {
  assert.equal(imapQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => imapQuote("a\r\nb"));
});

test("IMAP dates and headers", () => {
  assert.equal(imapDate("03-Nov-2026 15:40:07 -0500"), "2026-11-03T20:40:07.000Z");
  assert.equal(headerOf(EMAIL_1, "subject"), "Cake 🎂");
  assert.equal(headerOf(EMAIL_1, "Message-ID"), "<one@example.test>");
  assert.equal(headerOf(EMAIL_2, "Subject"), "Second folded");
  assert.equal(headerOf(EMAIL_2, "Message-ID"), "");
});
