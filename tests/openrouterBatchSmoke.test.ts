import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterBatchSmokeRunner, createSmokeRequest } from "../scripts/openrouterBatchSmoke.mjs";

const customId = "10000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`;
const batchId = "batch_smoke_123";
const apiCanary = "FAKE_API_KEY_MUST_NEVER_BE_PRINTED";
const requestCanary = "FICTIONAL_PROMPT_MUST_NEVER_BE_PRINTED";
const directories: string[] = [];
const scriptPath = fileURLToPath(new URL("../scripts/openrouterBatchSmoke.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "openrouter-smoke-test-"));
  directories.push(directory);
  const keyPath = join(directory, "openrouter-api-key.txt");
  const journalPath = join(directory, "openrouter-batch-smoke.json");
  await writeFile(keyPath, `${apiCanary}\n`, { mode: 0o600 });
  const output: string[] = [];
  const common = {
    keyPath,
    journalPath,
    uuid: () => customId,
    now: () => new Date("2026-10-13T12:00:00.000Z"),
    out: (text: string) => { output.push(text); return true; },
  };
  return { directory, keyPath, journalPath, output, common };
}

function batchPayload(status: string, extras: Record<string, unknown> = {}) {
  return {
    id: batchId,
    object: "batch",
    endpoint: "/v1/chat/completions",
    model: "openai/gpt-6-luna",
    completion_window: "24h",
    status,
    request_counts: { total: 1, completed: status === "completed" ? 1 : 0, failed: 0 },
    usage: status === "completed" ? { prompt_tokens: 12, completion_tokens: 3, reasoning_tokens: 1, total_tokens: 15, cost: 0.0007, is_byok: true } : null,
    results: status === "completed" ? [{
      id: "batch_req_smoke",
      custom_id: customId,
      response: {
        status_code: 200,
        body: {
          model: "openai/gpt-6-luna",
          choices: [{ finish_reason: "stop", message: { content: '{"ready":"READY"}' } }],
        },
      },
      error: null,
    }] : null,
    ...extras,
  };
}

async function seedSubmitted(journalPath: string) {
  await writeFile(journalPath, JSON.stringify({
    version: 1, status: "submitted", customId, batchId, model: "openai/gpt-6-luna",
    requestCount: 1, createdAt: "2026-10-13T12:00:00.000Z",
  }));
}

async function seedUnknown(journalPath: string) {
  await writeFile(journalPath, JSON.stringify({
    version: 1, status: "submission_unknown", customId, model: "openai/gpt-6-luna",
    requestCount: 1, createdAt: "2026-10-13T12:00:00.000Z",
  }));
}

async function seedLocatedDiagnostic(path: string, candidateId = "batch_candidate_verify") {
  await writeFile(path, JSON.stringify({
    version: 1,
    status: "located",
    sourceCustomId: customId,
    sourceCreatedAt: "2026-10-13T12:00:00.000Z",
    checkedAt: "2026-10-13T12:00:02.000Z",
    candidateIds: [candidateId],
  }));
}

describe("closed OpenRouter Batch readiness utility", () => {
  it("builds exactly one strict fictional JSON request with pinned provider and no token cap", () => {
    const body = createSmokeRequest(customId);
    expect(Object.keys(body)).toEqual(["endpoint", "model", "provider", "completion_window", "requests"]);
    expect(body).toMatchObject({
      endpoint: "/v1/chat/completions",
      model: "openai/gpt-6-luna",
      provider: { only: ["openai"], allow_fallbacks: false },
      completion_window: "24h",
    });
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].custom_id).toBe(customId);
    expect(body.requests[0].body.reasoning).toEqual({ effort: "low", exclude: true });
    expect(body.requests[0].body.response_format.json_schema.strict).toBe(true);
    expect((body.requests[0].body as { max_tokens?: unknown }).max_tokens).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("real");
  });

  it("writes an exclusive unknown intent before one POST and atomically records an accepted batch ID", async () => {
    const { common, journalPath, output } = await setup();
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/batches");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiCanary}`);
      const atDispatch = JSON.parse(await readFile(journalPath, "utf8"));
      expect(atDispatch).toMatchObject({ version: 1, status: "submission_unknown", customId, requestCount: 1 });
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body)).toEqual(["endpoint", "model", "provider", "completion_window", "requests"]);
      expect(body.requests[0].custom_id).toBe(customId);
      expect(body.requests[0].body.messages[1].content).not.toContain(requestCanary);
      return new Response(JSON.stringify({
        id: batchId, status: "validating", endpoint: "/v1/chat/completions", model: "openai/gpt-6-luna",
        completion_window: "24h", request_counts: { total: 1, completed: 0, failed: 0 },
      }), { status: 202 });
    });
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submitted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "submitted", batchId, customId });
    expect(output.join("")).toContain("status=submitted");
    expect(output.join("")).not.toContain(apiCanary);
    expect(output.join("")).not.toContain(customId);
    expect(output.join("")).not.toContain(requestCanary);
  });

  it("accepts the known canonical Luna model and opaque safe service IDs in a valid submission acknowledgement", async () => {
    const { common, journalPath } = await setup();
    const opaqueBatchId = `batch-${customId}`;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: opaqueBatchId, status: "validating", endpoint: "/v1/chat/completions",
      model: "openai/gpt-6-luna-20260922", completion_window: "24h",
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submitted" });
    expect(JSON.parse(await readFile(journalPath, "utf8")).batchId).toBe(opaqueBatchId);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe service IDs in submission acknowledgements", async () => {
    const { common, journalPath } = await setup();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: "batch/unsafe", status: "validating", endpoint: "/v1/chat/completions",
      model: "openai/gpt-6-luna", completion_window: "24h",
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submission_unknown" });
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "submission_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses any existing journal without making another POST", async () => {
    const { common, journalPath, output } = await setup();
    await writeFile(journalPath, "{}\n");
    const fetcher = vi.fn();
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "refused" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join("")).not.toContain(apiCanary);
  });

  it("awaits rejected HTTP body cancellation before returning and reports only the status code", async () => {
    const { common, output } = await setup();
    let bodyClosed = false;
    const fetcher = vi.fn(async () => ({
      status: 503,
      headers: new Headers(),
      body: { cancel: async () => { await Promise.resolve(); bodyClosed = true; } },
    } as unknown as Response));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submission_unknown" });
    expect(bodyClosed).toBe(true);
    expect(output.join("")).toContain("httpStatus=503");
    expect(output.join("")).not.toContain(apiCanary);
  });

  it("records an uncertain dispatch and never resubmits after a transport failure", async () => {
    const { common, journalPath, output } = await setup();
    const fetcher = vi.fn(async () => { throw new Error(apiCanary); });
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submission_unknown" });
    await expect(runner.submit()).resolves.toEqual({ status: "refused" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("submission_unknown");
    expect(output.join("")).not.toContain(apiCanary);
  });

  it("locates at most two candidates with one read-only GET and privately retains only candidate IDs", async () => {
    const { common, journalPath, output, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    const candidateIds = ["10000000-0000-4000-8000-000000000099", "opaque_candidate_two"];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/batches?limit=2&");
      expect(String(url)).toContain("created_after=");
      expect(String(url)).toContain("created_before=");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ data: candidateIds.map((id, index) => ({
        id,
        status: index === 0 ? "validating" : "in_progress",
        model: index === 0 ? "gpt-6-luna" : "openai/gpt-6-luna:batch",
        request_counts: { total: 1 },
        custom_id: `PRIVATE_CUSTOM_${index}`,
        [apiCanary]: "must-not-print-field-name",
      })) }), { status: 200 });
    });
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.locate()).resolves.toEqual({ status: "located", candidateCount: 2, validIdCount: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(await readFile(diagnosticJournalPath, "utf8"));
    expect(diagnostic).toMatchObject({ sourceCustomId: customId, candidateIds });
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("submission_unknown");
    expect(output.join("")).toContain("candidateCount=2");
    expect(output.join("")).toContain("candidate1IdKind=uuid");
    expect(output.join("")).toContain("candidate1ModelKind=bare_luna");
    expect(output.join("")).toContain("candidate2IdKind=opaque_safe");
    expect(output.join("")).toContain("candidate2ModelKind=expected_batch");
    expect(output.join("")).toContain("candidate1Fields=id:string,model:string,request_counts:object,status:string;unknownFieldCount=2");
    expect(output.join("")).not.toContain(candidateIds[0]);
    expect(output.join("")).not.toContain("PRIVATE_CUSTOM");
    expect(output.join("")).not.toContain(apiCanary);
    expect(output.join("")).not.toContain("must-not-print-field-name");
    expect(output.join("")).not.toContain(customId);
  });

  it("allows a repeated explicit locate only for the same original intent", async () => {
    const { common, journalPath, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await writeFile(diagnosticJournalPath, JSON.stringify({
      version: 1, status: "located", sourceCustomId: customId,
      sourceCreatedAt: "2026-10-13T12:00:00.000Z", checkedAt: "2026-10-13T12:00:01.000Z",
      candidateIds: ["batch_retained"],
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: "batch_new_candidate", status: "validating", model: "openai/gpt-6-luna", request_counts: { total: 1 },
    }] }), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.locate()).resolves.toMatchObject({ status: "located", validIdCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(diagnosticJournalPath, "utf8")).candidateIds).toEqual(["batch_new_candidate"]);
  });

  it("accepts only the known legacy diagnostic schema for the same source intent", async () => {
    const { common, journalPath, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await writeFile(diagnosticJournalPath, JSON.stringify({
      version: 1,
      sourceCustomId: customId,
      sourceCreatedAt: "2026-10-13T12:00:00.000Z",
      checkedAt: "2026-10-13T12:00:03.000Z",
      candidateIds: [],
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.locate()).resolves.toMatchObject({ status: "located", candidateCount: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses locate for a diagnostic journal bound to a different source intent", async () => {
    const { common, journalPath, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await writeFile(diagnosticJournalPath, JSON.stringify({
      version: 1, status: "located", sourceCustomId: "30000000-0000-4000-8000-000000000003",
      sourceCreatedAt: "2026-10-13T12:00:00.000Z", checkedAt: "2026-10-13T12:00:01.000Z",
      candidateIds: ["batch_retained"],
    }));
    const fetcher = vi.fn();
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.locate()).resolves.toEqual({ status: "refused" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(diagnosticJournalPath, "utf8")).candidateIds).toEqual(["batch_retained"]);
  });

  it("verifies an opaque located batch only with exact custom ID and keeps unexpected model classification separate", async () => {
    const { common, journalPath, directory, output } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    const candidateId = "10000000-0000-4000-8000-000000000099";
    await seedUnknown(journalPath);
    await seedLocatedDiagnostic(diagnosticJournalPath, candidateId);
    const payload = batchPayload("completed", { id: candidateId, model: "unexpected/provider-model" });
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`https://openrouter.ai/api/v1/batches/${candidateId}`);
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.verifyLocated()).resolves.toMatchObject({
      status: "verified", matchedCustomId: true, verifiedRequestOwned: true, structuredReadyValidated: true,
      modelVerified: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("modelKind=other");
    expect(output.join("")).toContain("modelVerified=false");
    expect(output.join("")).toContain("verifiedRequestOwned=true");
    expect(output.join("")).not.toContain("unexpected/provider-model");
    expect(output.join("")).not.toContain(candidateId);
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("submission_unknown");
    expect(JSON.parse(await readFile(diagnosticJournalPath, "utf8")).verification).toMatchObject({
      verifiedRequestOwned: true, structuredReadyValidated: true, modelKind: "other", resultModelKind: "expected_base", modelVerified: false,
    });
  });

  it("recognizes only the exact current canonical Luna model on both batch and inline result", async () => {
    const { common, journalPath, directory, output } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await seedLocatedDiagnostic(diagnosticJournalPath);
    const payload = batchPayload("completed", { id: "batch_candidate_verify", model: "openai/gpt-6-luna-20260922" });
    payload.results![0].response.body.model = "openai/gpt-6-luna-20260922";
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.verifyLocated()).resolves.toMatchObject({
      status: "verified", verifiedRequestOwned: true, structuredReadyValidated: true, modelVerified: true,
    });
    expect(output.join(" ")).toContain("modelKind=expected_canonical");
    expect(output.join(" ")).toContain("resultModelKind=expected_canonical");
    expect(JSON.parse(await readFile(diagnosticJournalPath, "utf8")).verification).toMatchObject({
      modelKind: "expected_canonical", resultModelKind: "expected_canonical", modelVerified: true,
    });
  });

  it.each([
    ["unknown dated canonical lookalike", "openai/gpt-6-luna-20260923"],
    ["canonical suffix near-match", "openai/gpt-6-luna-20260922:batch"],
    ["canonical prefix near-match", "provider/openai/gpt-6-luna-20260922"],
  ])("does not recognize %s as the approved canonical model", async (_label, unknownModel) => {
    const { common, journalPath, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await seedLocatedDiagnostic(diagnosticJournalPath);
    const payload = batchPayload("completed", { id: "batch_candidate_verify", model: unknownModel });
    payload.results![0].response.body.model = unknownModel;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.verifyLocated()).resolves.toMatchObject({
      status: "verified", verifiedRequestOwned: true, structuredReadyValidated: true, modelVerified: false,
    });
    const verification = JSON.parse(await readFile(diagnosticJournalPath, "utf8")).verification;
    expect(verification.modelKind).toBe("other");
    expect(verification.resultModelKind).toBe("other");
  });

  it("keeps model verification false when only the outer batch model is recognized", async () => {
    const { common, journalPath, directory } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await seedLocatedDiagnostic(diagnosticJournalPath);
    const payload = batchPayload("completed", { id: "batch_candidate_verify", model: "openai/gpt-6-luna-20260922" });
    payload.results![0].response.body.model = "openai/gpt-6-luna-20260923";
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.verifyLocated()).resolves.toMatchObject({
      status: "verified", verifiedRequestOwned: true, structuredReadyValidated: true, modelVerified: false,
    });
    expect(JSON.parse(await readFile(diagnosticJournalPath, "utf8")).verification).toMatchObject({
      modelKind: "expected_canonical", resultModelKind: "other", modelVerified: false,
    });
  });

  it("does not attribute a foreign custom ID or expose accounting when ownership is unverified", async () => {
    const { common, journalPath, directory, output } = await setup();
    const diagnosticJournalPath = join(directory, "diagnostic.json");
    await seedUnknown(journalPath);
    await seedLocatedDiagnostic(diagnosticJournalPath);
    const payload = batchPayload("completed", { id: "batch_candidate_verify" });
    payload.results![0].custom_id = "40000000-0000-4000-8000-000000000004";
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, journalPath, diagnosticJournalPath, fetcher });
    await expect(runner.verifyLocated()).resolves.toMatchObject({
      status: "not_owned", matchedCustomId: false, verifiedRequestOwned: false, structuredReadyValidated: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("verifiedRequestOwned=false");
    expect(output.join("")).not.toContain("costUsd");
    expect(output.join("")).not.toContain("promptTokens");
    expect(output.join("")).not.toContain("40000000-0000-4000-8000-000000000004");
  });

  it("checks an in-progress batch once and never polls automatically", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`https://openrouter.ai/api/v1/batches/${batchId}`);
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify(batchPayload("in_progress")), { status: 200 });
    });
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.check()).resolves.toMatchObject({ status: "in_progress", validatedResult: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("validatedResult=false");
  });

  it("verifies the inline completed result and reports provider cost without estimating", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(batchPayload("completed")), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.check()).resolves.toMatchObject({ status: "completed", validatedResult: true, costUsd: 0.0007 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("validatedResult=true");
    expect(output.join("")).toContain("promptTokens=12");
    expect(output.join("")).toContain("completionTokens=3");
    expect(output.join("")).toContain("reasoningTokens=1");
    expect(output.join("")).toContain("costUsd=0.0007");
    expect(output.join("")).toContain("BYOK");
    expect(output.join("")).not.toContain("READY");
    expect(output.join("")).not.toContain("batch_req_smoke");
  });

  it("does not validate malformed result IDs or print result contents", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const body = batchPayload("completed") as ReturnType<typeof batchPayload> & { results: Record<string, unknown>[] };
    body.results[0].custom_id = "20000000-0000-4000-8000-000000000002";
    body.results[0].response = { status_code: 200, body: { model: "openai/gpt-6-luna", choices: [{ finish_reason: "stop", message: { content: requestCanary } }] } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.check()).resolves.toMatchObject({ status: "completed", validatedResult: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("status=completed");
    expect(output.join("")).toContain("validatedResult=false");
    expect(output.join("")).not.toContain(requestCanary);
    expect(output.join("")).not.toContain(apiCanary);
  });

  it("does not fetch a separate output file when inline results are missing", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const payload = batchPayload("completed", { results: null, output_file_id: "output_smoke_123" });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.check()).resolves.toMatchObject({ status: "completed", validatedResult: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("validatedResult=false");
    expect(output.join("")).not.toContain("output_smoke_123");
  });

  it("keeps the unknown intent and refuses replay if the accepted batch ID cannot be saved", async () => {
    const { common, journalPath, output } = await setup();
    const realFs = await import("node:fs/promises");
    const fs = { ...realFs, rename: vi.fn(async () => { throw new Error(apiCanary); }) } as never;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: batchId, status: "validating", endpoint: "/v1/chat/completions", model: "openai/gpt-6-luna",
      completion_window: "24h", request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fs, fetcher });
    await expect(runner.submit()).resolves.toEqual({ status: "submission_unknown" });
    await expect(runner.submit()).resolves.toEqual({ status: "refused" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("submission_unknown");
    expect(output.join("")).not.toContain(apiCanary);
  });

  it("reports cost unavailable rather than estimating when the provider omits it", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const payload = batchPayload("completed", { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
    const runner = createOpenRouterBatchSmokeRunner({
      ...common,
      fetcher: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    await runner.check();
    expect(output.join("")).toContain("costUsd=unavailable");
    expect(output.join("")).not.toContain("estimated");
  });

  it("fails closed on an oversized response body without leaking it", async () => {
    const { common, journalPath, output } = await setup();
    await seedSubmitted(journalPath);
    const oversized = JSON.stringify({ ...batchPayload("in_progress"), extra: "x".repeat(256 * 1024) });
    const runner = createOpenRouterBatchSmokeRunner({
      ...common,
      fetcher: async () => new Response(oversized, { status: 200 }),
    });
    await expect(runner.check()).resolves.toEqual({ status: "status_unavailable" });
    expect(output.join("")).not.toContain("xxxxx");
  });

  it("cancels a response declared oversized before reading it", async () => {
    const { common, journalPath } = await setup();
    await seedSubmitted(journalPath);
    let bodyClosed = false;
    const runner = createOpenRouterBatchSmokeRunner({
      ...common,
      fetcher: async () => ({
        status: 200,
        headers: new Headers({ "content-length": String(256 * 1024 + 1) }),
        body: { cancel: async () => { bodyClosed = true; } },
      } as unknown as Response),
    });
    await expect(runner.check()).resolves.toEqual({ status: "status_unavailable" });
    expect(bodyClosed).toBe(true);
  });

  it("rejects oversized or noncanonical local journal timestamps without a request", async () => {
    const { common, journalPath, output } = await setup();
    const fetcher = vi.fn();
    await writeFile(journalPath, JSON.stringify({
      version: 1, status: "submitted", customId, batchId, model: "openai/gpt-6-luna",
      requestCount: 1, createdAt: "2026-10-13T12:00:00+00:00",
    }));
    const runner = createOpenRouterBatchSmokeRunner({ ...common, fetcher });
    await expect(runner.check()).resolves.toEqual({ status: "unavailable" });
    await writeFile(journalPath, " ".repeat(16 * 1024 + 1));
    await runner.check();
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join("")).toContain("no_valid_smoke_intent");
  });

  it("dispatches the hyphenated verify-located CLI mode without network or credentials when no intent exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "openrouter-cli-"));
    directories.push(directory);
    const result = spawnSync(process.execPath, [scriptPath, "verify-located"], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: directory },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("mode=verify-located status=precondition_unavailable");
    expect(result.stdout).not.toContain("status=failed");
    expect(result.stderr).toBe("");
  });
});
