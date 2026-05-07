import * as core from "@actions/core";
import * as glob from "@actions/glob";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 30_000;

interface StampInput {
  contentHash: string;
  fileName: string;
}

interface StampResult {
  ownershipId: string;
  stampId: string;
  contentHash: string;
  fileName: string | null;
  duplicate: boolean;
}

interface BatchResponse {
  results: StampResult[];
  creditsCharged: number;
  duplicateCount: number;
}

interface StampStatus {
  contentHash: string;
  status: "pending" | "anchored";
  anchor: { txHash: string; chain: string; blockNumber: number } | null;
}

interface ApiError {
  error: { type: string; message: string };
}

async function main(): Promise<void> {
  const apiKey = core.getInput("api-key", { required: true });
  const filesInput = core.getInput("files", { required: true });
  const jurisdiction = core.getInput("jurisdiction") || undefined;
  const locale = core.getInput("locale") || "en";
  const waitForAnchor = core.getBooleanInput("wait-for-anchor");
  const pollTimeoutSeconds = Number(core.getInput("poll-timeout-seconds") || "900");
  const outputJsonPath = core.getInput("output-json") || "bastamp-proofs.json";
  const apiBase = (core.getInput("api-base") || "https://bastamp.com/api/v1").replace(/\/$/, "");
  const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;

  if (!/^ba_(live|test)_[0-9a-f]{32}$/.test(apiKey)) {
    core.setFailed("api-key must look like ba_live_<32 hex chars>");
    return;
  }

  // Expand globs and hash each file locally — only the SHA-256 leaves the runner.
  const globber = await glob.create(filesInput, { matchDirectories: false });
  const matched = await globber.glob();
  if (matched.length === 0) {
    core.setFailed(`no files matched: ${filesInput.replace(/\n/g, ", ")}`);
    return;
  }
  core.info(`matched ${matched.length} file(s); hashing locally...`);

  const items: StampInput[] = [];
  for (const filePath of matched) {
    try {
      const contentHash = await sha256OfFile(filePath);
      items.push({ contentHash, fileName: basename(filePath) });
      core.info(`  ${basename(filePath)}  ${contentHash}`);
    } catch (e) {
      core.setFailed(`failed to hash ${filePath}: ${(e as Error).message}`);
      return;
    }
  }

  // Chunk into batches of 100 (API max) and submit each with a stable
  // idempotency key so a workflow retry doesn't double-charge.
  const chunks = chunk(items, BATCH_SIZE);
  const allResults: StampResult[] = [];
  let totalCharged = 0;

  for (let i = 0; i < chunks.length; i++) {
    const idempotencyKey = `${runId}-chunk-${i}`;
    core.info(`POST /v1/stamps/batch (chunk ${i + 1}/${chunks.length}, ${chunks[i].length} items)`);
    const body = {
      items: chunks[i],
      jurisdiction,
      locale,
    };
    const res = await fetch(`${apiBase}/stamps/batch`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "stamp-action/1.0",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = parseErr(text) || `HTTP ${res.status}`;
      core.setFailed(`batch ${i + 1} failed: ${detail}`);
      return;
    }
    const parsed = JSON.parse(text) as BatchResponse;
    allResults.push(...parsed.results);
    totalCharged += parsed.creditsCharged;
    core.info(`  charged=${parsed.creditsCharged}  duplicates=${parsed.duplicateCount}`);
  }

  core.info(`stamped ${allResults.length} item(s); credits charged: ${totalCharged}`);

  // Optional: poll until every stamp is anchored. The 5-min batch cron on
  // BA Stamp's side is the lower bound; allow up to poll-timeout-seconds.
  let anchorMap = new Map<string, StampStatus>();
  if (waitForAnchor) {
    core.info(`waiting for anchor (timeout ${pollTimeoutSeconds}s)...`);
    anchorMap = await waitForAnchors(
      apiBase,
      apiKey,
      allResults.map((r) => r.contentHash),
      pollTimeoutSeconds,
    );
  } else {
    // Single non-blocking peek so the output reflects current state, not just "queued".
    anchorMap = await fetchStatuses(apiBase, apiKey, allResults.map((r) => r.contentHash));
  }

  const enriched = allResults.map((r) => {
    const s = anchorMap.get(r.contentHash);
    return {
      ownershipId: r.ownershipId,
      stampId: r.stampId,
      contentHash: r.contentHash,
      fileName: r.fileName,
      duplicate: r.duplicate,
      anchored: s?.status === "anchored",
      txHash: s?.anchor?.txHash ?? null,
      chain: s?.anchor?.chain ?? null,
      blockNumber: s?.anchor?.blockNumber ?? null,
    };
  });

  const anchoredCount = enriched.filter((e) => e.anchored).length;
  const pendingCount = enriched.length - anchoredCount;

  await writeFile(outputJsonPath, JSON.stringify(enriched, null, 2));
  core.info(`wrote ${enriched.length} record(s) → ${outputJsonPath}`);

  core.setOutput("stamps", JSON.stringify(enriched));
  core.setOutput("pending-count", String(pendingCount));
  core.setOutput("anchored-count", String(anchoredCount));
  core.setOutput("credits-charged", String(totalCharged));

  if (waitForAnchor && pendingCount > 0) {
    core.setFailed(
      `wait-for-anchor timed out: ${pendingCount}/${enriched.length} stamps still pending after ${pollTimeoutSeconds}s. ` +
        `They will anchor on the next batch cycle — re-run with the same Idempotency-Key (the workflow run_id) to pick them up without re-charging.`,
    );
  }
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(`0x${hash.digest("hex")}`));
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseErr(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as ApiError;
    if (parsed?.error?.type) return `${parsed.error.type} — ${parsed.error.message}`;
  } catch {
    /* fall through */
  }
  return text.slice(0, 200) || null;
}

async function fetchStatuses(
  apiBase: string,
  apiKey: string,
  hashes: string[],
): Promise<Map<string, StampStatus>> {
  const map = new Map<string, StampStatus>();
  // Sequential is fine: we expect <=100 stamps in v1 typical workflows.
  for (const h of hashes) {
    const res = await fetch(`${apiBase}/stamps/${h}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": "stamp-action/1.0",
      },
    });
    if (!res.ok) continue;
    map.set(h, (await res.json()) as StampStatus);
  }
  return map;
}

async function waitForAnchors(
  apiBase: string,
  apiKey: string,
  hashes: string[],
  timeoutSeconds: number,
): Promise<Map<string, StampStatus>> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let map = new Map<string, StampStatus>();
  while (Date.now() < deadline) {
    map = await fetchStatuses(apiBase, apiKey, hashes);
    const pending = hashes.filter((h) => map.get(h)?.status !== "anchored").length;
    core.info(`  pending: ${pending}/${hashes.length}`);
    if (pending === 0) return map;
    await sleep(POLL_INTERVAL_MS);
  }
  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
