// Claude Code headless (`claude -p`) as the writer of the cash count reminders,
// on the owner's Claude subscription (no API key; the owner's ruling,
// 2026-10-29). The bj-box job reads the subscription token from Vault
// (claude_usage_token) and hands it here; it goes into the child's environment
// as CLAUDE_CODE_OAUTH_TOKEN and nowhere else: not on the command line (any
// user on the box can read another process's argv), not in this process's own
// environment, never in a log line.
//
// One call per message: no tools, no settings files, no MCP servers, no slash
// commands, no session saved, the system prompt replaced, a hard timeout. The
// prompt goes in on stdin. The answer is read from --output-format json.
//
// Every failure is an answer, never a throw: CLI missing, non-zero exit,
// timeout, an error result (a usage limit, a bad token), unreadable output.
// message.ts turns any of them into the plain fallback message.

import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";

/** The current Haiku. Claude Code 2.1.299 or later knows it (bj-box installs a pinned version, Software-Factory droplet/). */
export const MODEL = "claude-haiku-5-5";
/** Long enough for Claude Code's start-up plus one short Haiku answer; the job's unit allows several. */
export const TIMEOUT_MS = 45_000;
/** More output than this is not a two-line Slack message; stop reading. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export type ClaudeAnswer = { ok: true; text: string } | { ok: false; reason: string };
/** Ask Claude for one message. Resolves; never rejects. */
export type AskClaude = (request: { system: string; prompt: string }) => Promise<ClaudeAnswer>;

export type ClaudeCliOptions = {
  /** The claude executable: a path, or a name found on PATH. */
  bin: string;
  /** The subscription token (Vault claude_usage_token). */
  token: string;
  /** The environment the child's PATH, HOME and locale come from. Nothing else in it is passed on. */
  env: Record<string, string | undefined>;
  timeoutMs?: number;
};

/** The child's whole environment: what Claude Code needs to run, the token, and switches that keep it quiet. */
export function childEnv(env: Record<string, string | undefined>, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME"]) {
    const v = env[key];
    if (v) out[key] = v;
  }
  out.CLAUDE_CODE_OAUTH_TOKEN = token;
  out.DISABLE_AUTOUPDATER = "1";
  out.DISABLE_TELEMETRY = "1";
  out.DISABLE_ERROR_REPORTING = "1";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return out;
}

/** The command line. Nothing secret and nothing per-message is on it; the prompt goes on stdin. */
export function cliArgs(system: string): string[] {
  return [
    "-p",
    "--model", MODEL,
    "--effort", "low",
    "--tools", "",
    "--system-prompt", system,
    "--output-format", "json",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
}

type CliResult = { type?: string; subtype?: string; is_error?: boolean; result?: unknown; api_error_status?: number | null; stop_reason?: string | null };

/** What Claude Code printed, as an answer. */
export function readCliOutput(code: number | null, stdout: string, stderr: string): ClaudeAnswer {
  let parsed: CliResult | null = null;
  try {
    // The json format prints one object; take the last line in case anything precedes it.
    const last = stdout.trim().split("\n").pop() ?? "";
    parsed = JSON.parse(last) as CliResult;
  } catch {
    parsed = null;
  }
  if (parsed && parsed.type === "result") {
    const text = typeof parsed.result === "string" ? parsed.result : "";
    if (parsed.is_error || parsed.subtype !== "success") {
      const status = parsed.api_error_status ? ` ${parsed.api_error_status}` : "";
      return { ok: false, reason: `claude error${status}: ${oneLine(text) || parsed.subtype || "no detail"}` };
    }
    if (code !== 0) return { ok: false, reason: `claude exited ${code}` };
    // Cut off or declined: whatever text there is was not finished.
    if (parsed.stop_reason === "max_tokens" || parsed.stop_reason === "refusal") return { ok: false, reason: `claude stopped: ${parsed.stop_reason}` };
    return { ok: true, text };
  }
  const detail = oneLine(stderr) || oneLine(stdout);
  return { ok: false, reason: code === 0 ? "claude printed no result" : `claude exited ${code}${detail ? `: ${detail}` : ""}` };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** An AskClaude that runs Claude Code headless once per message. */
export function claudeCli(opts: ClaudeCliOptions): AskClaude {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return ({ system, prompt }) =>
    new Promise<ClaudeAnswer>((resolve) => {
      let settled = false;
      const done = (answer: ClaudeAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      let child: ChildProcess;
      try {
        // cwd is a scratch directory so no project CLAUDE.md is picked up. The
        // cast: Next's typings require NODE_ENV in ProcessEnv, and the child's
        // environment leaves it out on purpose (childEnv).
        const env = childEnv(opts.env, opts.token) as NodeJS.ProcessEnv;
        child = spawn(opts.bin, cliArgs(system), { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, reason: `claude could not start: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({ ok: false, reason: `claude timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        done({ ok: false, reason: e.code === "ENOENT" ? `claude not found (${opts.bin})` : `claude could not start: ${e.message}` });
      });
      child.on("close", (code: number | null) => done(readCliOutput(code, stdout, stderr)));
      child.stdin?.on("error", () => {
        /* the child exited before reading its prompt; "close" reports it */
      });
      child.stdin?.end(prompt);
    });
}
