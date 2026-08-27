#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = path.resolve(process.env.IMAGE2_LIVE_OUTPUT_DIR || path.join(os.tmpdir(), "dadaapi-image2-live-matrix"));
const STATE_FILE = path.join(OUTPUT_DIR, "matrix-state.json");
const CALL_TIMEOUT_MS = 360000;
// Includes one explicitly authorized retry after the first production G1
// completed upstream but its response body was lost in transit.
const MAX_REQUEST_ATTEMPTS = 17;
const MAX_REQUESTED_FINAL_IMAGES = 21;
const MAX_PARTIAL_REQUESTS = 7;

if (!process.env.IMAGE2_API_KEY) throw new Error("IMAGE2_API_KEY must be set in the process environment.");
if (!process.env.IMAGE2_BASE_URL) throw new Error("IMAGE2_BASE_URL must be set in the process environment.");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const state = loadState();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PLUGIN_ROOT, "server.js")],
  cwd: PLUGIN_ROOT,
  env: {
    ...process.env,
    IMAGE2_MODEL: "gpt-image-2",
    IMAGE2_DEFAULT_OUTPUT_DIR: OUTPUT_DIR
  },
  stderr: "pipe"
});
const client = new Client({ name: "dadaapi-image2-live-validation", version: "1.0.0" });

try {
  await client.connect(transport);
  await runGenerations();
  await runEdits();
  state.completed_at = new Date().toISOString();
  writeState();
  console.log(JSON.stringify({
    status: "completed",
    state_file: STATE_FILE,
    requests: successfulCases().length,
    final_images: successfulCases().reduce((sum, item) => sum + item.images.length, 0)
  }));
} finally {
  await transport.close();
}

async function runGenerations() {
  const baseA = "A glossy red ceramic coffee mug centered on a plain white studio background, soft even lighting, no text, no logo.";
  const baseB = "A clean top-down product photo of a blue notebook and a yellow wooden pencil on a pale gray desk, no text, no logo.";
  const cases = [
    generation("G1", baseA, 1, false, 0),
    generation("G4", baseB, 2, false, 0),
    generation("G2", "A small green potted succulent centered on a white studio background, no text.", 1, true, 0),
    generation("G3", "A bright yellow toy sailboat centered on a light blue studio background, no text.", 1, true, 1),
    generation("G5", "A minimal red desk lamp on a neutral studio background, no text.", 2, true, 1),
    generation("G1R", baseA, 1, false, 0),
    generation("G3R", "A bright yellow toy sailboat centered on a light blue studio background, no text.", 1, true, 1)
  ];
  for (const item of cases) await runCase(item);
}

async function runEdits() {
  const baselineA = successfulCase("G1").images[0].path;
  const baselineB = successfulCase("G4").images[0].path;
  const cases = [
    edit("E1", [baselineA], "Change only the mug color from red to emerald green. Keep the mug shape, camera, lighting, shadows, and white background unchanged.", 1, false, 0),
    edit("E2", [baselineA], "Add a small white five-point star centered on the mug. Keep everything else unchanged.", 1, true, 0),
    edit("E3", [baselineA], "Change only the white studio background to pale blue. Keep the red mug, its shape, lighting, and shadow unchanged.", 1, true, 1),
    edit("E4", [baselineA, baselineB], "Create one coherent top-down product composition containing the red mug from image 1 beside the blue notebook and yellow pencil from image 2. Preserve each product's identity and colors. No text.", 1, false, 0),
    edit("E5", [baselineA, baselineB], "Create one coherent studio composition containing the red mug from image 1 beside the blue notebook and yellow pencil from image 2. Preserve each product's identity and colors. No text.", 1, true, 1),
    edit("E6", [baselineA], "Replace only the white background with a light gray seamless studio background. Keep the red mug unchanged.", 2, false, 0),
    edit("E7", [baselineA], "Add a thin navy horizontal stripe around the middle of the red mug. Keep the mug shape, background, lighting, and shadow unchanged.", 2, true, 1),
    edit("E1R", [baselineA], "Change only the mug color from red to emerald green. Keep the mug shape, camera, lighting, shadows, and white background unchanged.", 1, false, 0),
    edit("E3R", [baselineA], "Change only the white studio background to pale blue. Keep the red mug, its shape, lighting, and shadow unchanged.", 1, true, 1)
  ];
  for (const item of cases) await runCase(item);
}

function generation(id, prompt, n, stream, partialImages) {
  return {
    id,
    tool: "image2_generate",
    operation: "generation",
    expectedFinals: n,
    arguments: commonArguments(id, prompt, n, stream, partialImages)
  };
}

function edit(id, imagePaths, prompt, n, stream, partialImages) {
  return {
    id,
    tool: "image2_edit",
    operation: "edit",
    expectedFinals: n,
    arguments: {
      ...commonArguments(id, prompt, n, stream, partialImages),
      image_paths: imagePaths
    }
  };
}

function commonArguments(id, prompt, n, stream, partialImages) {
  return {
    prompt,
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "low",
    background: "auto",
    output_format: "png",
    moderation: "auto",
    n,
    stream,
    partial_images: partialImages,
    output_dir: OUTPUT_DIR,
    filename_prefix: id.toLowerCase()
  };
}

async function runCase(testCase) {
  if (state.cases[testCase.id]?.status === "success") {
    validateSavedCase(state.cases[testCase.id], testCase.expectedFinals);
    console.log(JSON.stringify({ id: testCase.id, status: "skipped-success" }));
    return;
  }

  enforceBudget(testCase);
  const started = Date.now();
  console.log(JSON.stringify({ id: testCase.id, status: "started" }));
  try {
    const attempt = {
      id: testCase.id,
      started_at: new Date().toISOString(),
      status: "running",
      requested_finals: testCase.expectedFinals,
      partial_images_requested: testCase.arguments.partial_images
    };
    state.attempts.push(attempt);
    writeState();
    const result = await client.callTool(
      { name: testCase.tool, arguments: testCase.arguments },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS }
    );
    const body = toolPayload(result);
    if (result.isError || body.ok === false) {
      throw Object.assign(new Error(`${body.error?.code || "TOOL_ERROR"}: ${body.error?.message || "Image tool failed."}`), { body });
    }
    assert.equal(body.stream_requested, testCase.arguments.stream);
    assert.equal(body.partial_images_requested, testCase.arguments.partial_images);
    assert.ok(["json", "sse"].includes(body.response_mode));
    assert.equal(body.http_status, 200);
    assert.equal(body.images.length, testCase.expectedFinals);

    const images = body.images.map(inspectImage);
    const partialImages = (body.partial_images || []).map(inspectImage);
    const record = {
      id: testCase.id,
      status: "success",
      operation: testCase.operation,
      request: requestSummary(testCase.arguments),
      http_status: body.http_status,
      response_content_type: body.response_content_type,
      request_id: body.request_id || null,
      upstream_request_id: body.upstream_request_id || null,
      client_request_id: body.client_request_id || null,
      stream_requested: body.stream_requested,
      response_mode: body.response_mode,
      partial_images_requested: body.partial_images_requested,
      event_counts: body.stream_diagnostics?.event_counts || {},
      done_seen: body.stream_diagnostics?.done_seen ?? null,
      images,
      partial_images: partialImages,
      duration_ms: Date.now() - started,
      visual_check: testCase.operation === "edit" ? "pending" : "not_required"
    };
    state.cases[testCase.id] = record;
    Object.assign(attempt, { status: "success", completed_at: new Date().toISOString() });
    writeState();
    console.log(JSON.stringify({
      id: record.id,
      status: record.status,
      response_mode: record.response_mode,
      images: record.images.length,
      partial_images: record.partial_images.length,
      duration_ms: record.duration_ms
    }));
  } catch (error) {
    const attempt = state.attempts.at(-1);
    if (attempt?.id === testCase.id && attempt.status === "running") {
      Object.assign(attempt, { status: "failed", completed_at: new Date().toISOString(), error: safeError(error) });
    }
    state.cases[testCase.id] = {
      id: testCase.id,
      status: "failed",
      operation: testCase.operation,
      request: requestSummary(testCase.arguments),
      duration_ms: Date.now() - started,
      error: safeError(error)
    };
    writeState();
    console.error(JSON.stringify({ id: testCase.id, status: "failed", error: safeError(error) }));
    throw error;
  }
}

function enforceBudget(nextCase) {
  const projectedRequests = state.attempts.length + 1;
  const projectedFinals = state.attempts.reduce((sum, item) => sum + item.requested_finals, 0) + nextCase.expectedFinals;
  const projectedPartialRequests = state.attempts.filter((item) => item.partial_images_requested > 0).length
    + (nextCase.arguments.partial_images > 0 ? 1 : 0);
  if (projectedRequests > MAX_REQUEST_ATTEMPTS || projectedFinals > MAX_REQUESTED_FINAL_IMAGES || projectedPartialRequests > MAX_PARTIAL_REQUESTS) {
    throw new Error("Live validation budget guard rejected the next request.");
  }
}

function validateSavedCase(record, expectedFinals) {
  assert.equal(record.images.length, expectedFinals);
  for (const image of record.images) inspectImage(image);
  for (const image of record.partial_images || []) inspectImage(image);
}

function inspectImage(value) {
  const filePath = typeof value === "string" ? value : value.path;
  assert.ok(filePath && path.isAbsolute(filePath));
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length > 0);
  const format = imageFormat(bytes);
  assert.ok(format, `Unsupported image signature: ${filePath}`);
  const metadata = imageMetadata(filePath);
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 1024);
  return {
    path: filePath,
    bytes: bytes.length,
    format,
    width: metadata.width,
    height: metadata.height
  };
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function imageMetadata(filePath) {
  const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], { encoding: "utf8" });
  return {
    width: Number(output.match(/pixelWidth:\s*(\d+)/i)?.[1] || 0),
    height: Number(output.match(/pixelHeight:\s*(\d+)/i)?.[1] || 0)
  };
}

function requestSummary(args) {
  return {
    model: args.model,
    size: args.size,
    quality: args.quality,
    output_format: args.output_format,
    n: args.n,
    stream: args.stream,
    partial_images: args.partial_images,
    input_count: args.image_paths?.length || 0,
    prompt: args.prompt
  };
}

function toolPayload(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Tool result did not include JSON text.");
  return JSON.parse(text);
}

function safeError(error) {
  const bodyError = error?.body?.error;
  return {
    code: bodyError?.code || error?.code || "LIVE_TEST_ERROR",
    stage: bodyError?.stage || null,
    message: String(bodyError?.message || error?.message || error).slice(0, 500),
    status: bodyError?.status ?? null,
    request_id: bodyError?.request_id || null,
    upstream_request_id: bodyError?.upstream_request_id || null,
    details: bodyError?.details || null
  };
}

function successfulCase(id) {
  const record = state.cases[id];
  if (!record || record.status !== "success") throw new Error(`Required successful case ${id} is unavailable.`);
  return record;
}

function successfulCases() {
  return Object.values(state.cases).filter((item) => item.status === "success");
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { version: 1, started_at: new Date().toISOString(), cases: {}, attempts: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (parsed.version !== 1 || !parsed.cases) throw new Error("Unsupported live matrix state file.");
  if (!Array.isArray(parsed.attempts)) {
    parsed.attempts = Object.values(parsed.cases).map((item) => ({
      id: item.id,
      started_at: parsed.started_at,
      completed_at: parsed.started_at,
      status: item.status,
      requested_finals: item.request?.n || item.images?.length || 0,
      partial_images_requested: item.request?.partial_images || 0,
      ...(item.error ? { error: item.error } : {})
    }));
  }
  return parsed;
}

function writeState() {
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_FILE);
}
