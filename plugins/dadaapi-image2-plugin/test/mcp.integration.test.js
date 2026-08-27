import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 2)
]);
const PNG_2 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 3)
]);

test("MCP tools persist URL images, expose diagnostics, preserve MIME, and keep generation quota-safe", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dadaapi-image2-mcp-"));
  const inputPath = path.join(outputDir, "input.png");
  const inputPath2 = path.join(outputDir, "input-2.png");
  fs.writeFileSync(inputPath, PNG);
  fs.writeFileSync(inputPath2, PNG_2);
  const state = {
    generations: 0,
    downloads: 0,
    models: 0,
    edits: 0,
    downloadAuthorization: [],
    generationAccept: [],
    editAccept: [],
    editBody: ""
  };
  const apiServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      state.models += 1;
      return json(response, 200, { data: [{ id: "gpt-image-2" }] }, {
        "x-oneapi-request-id": "gateway_doctor",
        "x-request-id": "req_doctor"
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/images/generations") {
      state.generations += 1;
      state.generationAccept.push(request.headers.accept || null);
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      if (body.prompt === "empty result") {
        return json(response, 200, { data: [] }, { "x-request-id": "req_empty" });
      }
      if (body.prompt === "download result") {
        return json(response, 200, { data: [{ url: "files/generated.png?signature=private" }] }, {
          "x-oneapi-request-id": "gateway_url",
          "x-request-id": "req_url"
        });
      }
      if (body.prompt === "json fallback stream") {
        return json(response, 200, { data: [{ b64_json: PNG.toString("base64") }] }, { "x-request-id": "req_json_fallback" });
      }
      if (body.prompt === "stream result" || body.prompt === "async stream result" || body.prompt === "forced sse") {
        response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_stream" });
        response.write(`event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"${PNG.toString("base64")}"}\n\n`);
        if (body.prompt === "async stream result") await new Promise((resolve) => setTimeout(resolve, 150));
        response.write(`event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"${PNG.toString("base64")}"}\n\n`);
        return response.end("data: [DONE]\n\n");
      }
      return json(response, 200, { data: [{ b64_json: PNG.toString("base64") }] }, { "x-request-id": "req_async" });
    }
    if (request.method === "GET" && url.pathname === "/v1/files/generated.png") {
      state.downloads += 1;
      state.downloadAuthorization.push(request.headers.authorization || null);
      if (state.downloads === 1) {
        response.writeHead(503);
        return response.end("retry");
      }
      response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      return response.end(PNG);
    }
    if (request.method === "POST" && url.pathname === "/v1/images/edits") {
      state.edits += 1;
      state.editAccept.push(request.headers.accept || null);
      state.editBody = (await readBody(request)).toString("latin1");
      if (/name="prompt"\r\n\r\njson fallback edit/.test(state.editBody)) {
        return json(response, 200, { data: [{ b64_json: PNG.toString("base64") }] }, { "x-request-id": "req_edit_json_fallback" });
      }
      if (/name="prompt"\r\n\r\nforced sse edit/.test(state.editBody)) {
        response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_edit_forced_sse" });
        response.write(`event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"${PNG.toString("base64")}"}\n\n`);
        return response.end("data: [DONE]\n\n");
      }
      if (/name="stream"\r\n\r\ntrue/.test(state.editBody)) {
        response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_edit_stream" });
        response.write(`event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","b64_json":"${PNG.toString("base64")}"}\n\n`);
        response.write(`event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"${PNG.toString("base64")}"}\n\n`);
        return response.end("data: [DONE]\n\n");
      }
      return json(response, 200, { data: [{ b64_json: PNG.toString("base64") }] }, { "x-request-id": "req_edit" });
    }
    response.writeHead(404);
    response.end("not found");
  });

  await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const address = apiServer.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PLUGIN_ROOT, "server.js")],
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      IMAGE2_API_KEY: "integration-key",
      IMAGE2_BASE_URL: `http://127.0.0.1:${address.port}`,
      IMAGE2_MODEL: "gpt-image-2",
      IMAGE2_DEFAULT_OUTPUT_DIR: outputDir,
      IMAGE2_REQUEST_TIMEOUT_MS: "5000",
      IMAGE2_DOWNLOAD_TIMEOUT_MS: "1000",
      IMAGE2_MAX_OUTPUT_BYTES: "1024"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "dadaapi-image2-test", version: "1.0.0" });
  let jobId;

  try {
    await client.connect(transport);

    const doctor = payload(await client.callTool({ name: "image2_doctor", arguments: { network: true } }));
    assert.equal(doctor.status, "pass");
    assert.equal(doctor.request_id, "gateway_doctor");
    assert.equal(doctor.upstream_request_id, "req_doctor");
    assert.equal(state.models, 1);

    const generatedResult = await client.callTool({
      name: "image2_generate",
      arguments: { prompt: "download result", output_dir: outputDir, filename_prefix: "url" }
    });
    const generated = payload(generatedResult);
    assert.equal(generatedResult.isError, undefined);
    assert.equal(generated.request_id, "gateway_url");
    assert.equal(generated.upstream_request_id, "req_url");
    assert.equal(generated.stream_requested, false);
    assert.equal(generated.response_mode, "json");
    assert.equal(generated.partial_images_requested, 0);
    assert.equal(generated.http_status, 200);
    assert.equal(generated.response_content_type, "application/json");
    assert.equal(generated.images[0].source, "url");
    assert.equal(fs.readFileSync(generated.images[0].path).subarray(0, 8).equals(PNG.subarray(0, 8)), true);
    assert.equal(state.generations, 1);
    assert.equal(state.downloads, 2);
    assert.deepEqual(state.downloadAuthorization, [null, null]);
    assert.equal(state.generationAccept[0], "application/json");

    const jsonFallback = payload(await client.callTool({
      name: "image2_generate",
      arguments: {
        prompt: "json fallback stream",
        stream: true,
        partial_images: 1,
        output_dir: outputDir,
        filename_prefix: "fallback"
      }
    }));
    assert.equal(jsonFallback.stream, true);
    assert.equal(jsonFallback.stream_requested, true);
    assert.equal(jsonFallback.response_mode, "json");
    assert.equal(jsonFallback.partial_images_requested, 1);
    assert.deepEqual(jsonFallback.partial_images, []);
    assert.equal(state.generationAccept[1], "text/event-stream");

    const forcedSse = payload(await client.callTool({
      name: "image2_generate",
      arguments: {
        prompt: "forced sse",
        stream: false,
        output_dir: outputDir,
        filename_prefix: "forced-sse"
      }
    }));
    assert.equal(forcedSse.stream_requested, false);
    assert.equal(forcedSse.response_mode, "sse");
    assert.equal(forcedSse.images.length, 1);
    assert.equal(forcedSse.stream_diagnostics.event_counts["image_generation.completed"], 1);
    assert.equal(state.generationAccept[2], "application/json");

    const edited = payload(await client.callTool({
      name: "image2_edit",
      arguments: {
        prompt: "keep the image",
        image_paths: [inputPath, inputPath2],
        output_dir: outputDir,
        filename_prefix: "edit"
      }
    }));
    assert.equal(edited.request_id, "req_edit");
    assert.equal(edited.stream_requested, false);
    assert.equal(edited.response_mode, "json");
    assert.equal(edited.input_context.image_count, 2);
    assert.equal(edited.input_context.prepared_images.every((item) => item.prepared === false), true);
    assert.equal(state.edits, 1);
    assert.match(state.editBody, /Content-Type: image\/png/i);
    assert.equal(state.editBody.match(/name="image\[\]"/g)?.length, 2);
    assert.equal(state.editAccept[0], "application/json");

    const streamedEdit = payload(await client.callTool({
      name: "image2_edit",
      arguments: {
        prompt: "stream edit",
        image_paths: [inputPath],
        input_preprocessing: false,
        stream: true,
        partial_images: 1,
        output_dir: outputDir,
        filename_prefix: "edit-stream"
      }
    }));
    assert.equal(streamedEdit.response_mode, "sse");
    assert.equal(streamedEdit.partial_images.length, 1);
    assert.equal(streamedEdit.images.length, 1);
    assert.equal(streamedEdit.stream_diagnostics.event_counts["image_edit.partial_image"], 1);
    assert.equal(state.editAccept[1], "text/event-stream");

    const editJsonFallback = payload(await client.callTool({
      name: "image2_edit",
      arguments: {
        prompt: "json fallback edit",
        image_paths: [inputPath],
        stream: true,
        partial_images: 1,
        output_dir: outputDir,
        filename_prefix: "edit-json-fallback"
      }
    }));
    assert.equal(editJsonFallback.stream_requested, true);
    assert.equal(editJsonFallback.response_mode, "json");
    assert.equal(editJsonFallback.images.length, 1);
    assert.equal(state.editAccept[2], "text/event-stream");

    const editForcedSse = payload(await client.callTool({
      name: "image2_edit",
      arguments: {
        prompt: "forced sse edit",
        image_paths: [inputPath],
        stream: false,
        output_dir: outputDir,
        filename_prefix: "edit-forced-sse"
      }
    }));
    assert.equal(editForcedSse.stream_requested, false);
    assert.equal(editForcedSse.response_mode, "sse");
    assert.equal(editForcedSse.images.length, 1);
    assert.equal(state.editAccept[3], "application/json");

    for (const arguments_ of [
      { prompt: "bad partial", partial_images: 1 },
      { prompt: "bad extra", extra: { stream: true } },
      { prompt: "bad size", size: "1000x1000" },
      { prompt: "bad transparent", background: "transparent", output_format: "jpeg" }
    ]) {
      const invalidResult = await client.callTool({ name: "image2_generate", arguments: arguments_ });
      const invalid = payload(invalidResult);
      assert.equal(invalidResult.isError, true);
      assert.equal(invalid.error.code, "INVALID_ARGUMENT");
    }
    assert.equal(state.generations, 3);

    const emptyResult = await client.callTool({
      name: "image2_generate",
      arguments: { prompt: "empty result", output_dir: outputDir }
    });
    const empty = payload(emptyResult);
    assert.equal(emptyResult.isError, true);
    assert.equal(empty.error.code, "EMPTY_IMAGE_RESULT");
    assert.equal(empty.error.request_id, "req_empty");
    assert.equal(state.generations, 4);

    const started = payload(await client.callTool({
      name: "image2_start_generation",
      arguments: {
        prompt: "async stream result",
        stream: true,
        partial_images: 1,
        output_dir: outputDir,
        filename_prefix: "async"
      }
    }));
    jobId = started.job_id;
    let job;
    let sawRunningPartial = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      job = payload(await client.callTool({ name: "image2_get_job", arguments: { job_id: jobId } }));
      if (job.status === "running" && job.partial_images?.length === 1) sawRunningPartial = true;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job.status, "completed");
    assert.equal(sawRunningPartial, true);
    assert.equal(job.result.request_id, "req_stream");
    assert.equal(job.result.response_mode, "sse");
    assert.ok(fs.existsSync(job.result.images[0].path));
    assert.equal(state.generations, 5);
  } finally {
    await transport.close();
    await new Promise((resolve) => apiServer.close(resolve));
    fs.rmSync(outputDir, { recursive: true, force: true });
    if (jobId) {
      const jobFile = path.join(PLUGIN_ROOT, "jobs", `${jobId}.json`);
      fs.rmSync(jobFile, { force: true });
    }
    removeDirectoryIfEmpty(path.join(PLUGIN_ROOT, "jobs"));
    removeDirectoryIfEmpty(path.join(PLUGIN_ROOT, "input-cache"));
  }
});

function payload(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool result should contain JSON text");
  return JSON.parse(text);
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function removeDirectoryIfEmpty(directory) {
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {
    // The server may not have created the directory.
  }
}
