import { promises as fs } from "fs";
import type { PfData } from "./types";

// The personal-finance feed is a single JSON document produced daily by the
// feed lane. It is ONLY read server-side (server components / route
// handlers) — it must never be served from a public path, fetched by the
// client, or committed to this public repo.
//
// Two modes:
//  - Dev:  PF_DATA_PATH points at a local JSON file (e.g. the committed
//          synthetic fixture fixtures/pf_data.sample.json).
//  - Prod (Vercel): PF_GITHUB_TOKEN (fine-grained PAT, contents:read on the
//          private data repo only) lets us fetch pf_data.json from the
//          private repo's `pf-data` branch via the GitHub contents API.
//          Responses are cached briefly so page loads don't hammer the API.
//  - Neither env set: pages render their "feed not wired yet" state.

const PF_FEED_REPO = "BenJerrysUpenn/personal-finance";
const PF_FEED_BRANCH = "pf-data";
const PF_FEED_FILE = "pf_data.json";
const REVALIDATE_SECONDS = 300;

export type PfLoadResult =
  | { ok: true; data: PfData }
  | { ok: false; reason: "missing" | "malformed" };

function validate(data: PfData): boolean {
  return Boolean(
    data &&
      typeof data === "object" &&
      data.meta?.generated_at &&
      data.meta.reconciliation &&
      Array.isArray(data.explorer?.rows) &&
      Array.isArray(data.explorer?.months) &&
      Array.isArray(data.dial?.streams) &&
      Array.isArray(data.dial?.months) &&
      data.safe_to_spend?.month &&
      Array.isArray(data.safe_to_spend?.habits),
  );
}

function parse(raw: string): PfLoadResult {
  try {
    const data = JSON.parse(raw) as PfData;
    if (!validate(data)) return { ok: false, reason: "malformed" };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

async function loadFromFile(path: string): Promise<PfLoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  return parse(raw);
}

async function loadFromGitHub(token: string): Promise<PfLoadResult> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${PF_FEED_REPO}/contents/${PF_FEED_FILE}?ref=${PF_FEED_BRANCH}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        next: { revalidate: REVALIDATE_SECONDS },
      },
    );
    if (!res.ok) return { ok: false, reason: "missing" };
    return parse(await res.text());
  } catch {
    return { ok: false, reason: "missing" };
  }
}

export async function loadPfData(): Promise<PfLoadResult> {
  const path = process.env.PF_DATA_PATH;
  if (path) return loadFromFile(path);
  const token = process.env.PF_GITHUB_TOKEN;
  if (token) return loadFromGitHub(token);
  return { ok: false, reason: "missing" };
}
