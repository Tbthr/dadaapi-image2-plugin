import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  Image2Error,
  consumeImageApiResponse,
  consumeImageStream,
  detectImageFormat,
  mimeTypeForPath,
  parseSseEvent,
  persistImagesFromResponse,
  requestApiJson,
  toolErrorPayload
} from "../lib/image-transport.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1)
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("persists every supported base64 field and uses the detected format", async () => {
  const outputDir = temporaryDirectory();
  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  const images = await persistImagesFromResponse({
    data: [
      { b64_json: PNG.toString("base64") },
      { image: JPEG.toString("base64") },
      { data: WEBP.toString("base64") },
      { url: dataUrl }
    ]
  }, options(outputDir));

  assert.deepEqual(images.map((image) => image.format), ["png", "jpeg", "webp", "png"]);
  assert.deepEqual(images.map((image) => image.source), ["base64", "base64", "base64", "base64"]);
  assert.ok(images[0].path.endsWith(".png"));
  assert.ok(images[1].path.endsWith(".jpg"));
  assert.ok(images[2].path.endsWith(".webp"));
  assert.ok(images.every((image) => fs.statSync(image.path).size === image.bytes));
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("supports nested base64 fallback", async () => {
  const outputDir = temporaryDirectory();
  const images = await persistImagesFromResponse({ output: { image: PNG.toString("base64") } }, options(outputDir));
  assert.equal(images.length, 1);
  assert.equal(images[0].format, "png");
});

test("downloads relative URLs, retries only the download, and never forwards authorization", async () => {
  const outputDir = temporaryDirectory();
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push({ url: String(url), authorization: new Headers(request.headers).get("authorization") });
    if (requests.length === 1) return new Response("busy", { status: 503 });
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  };

  const images = await persistImagesFromResponse({ data: [{ url: "files/result.png?signature=secret" }] }, {
    ...options(outputDir),
    fetchImpl,
    downloadRetryDelayMs: 1
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://provider.example/v1/files/result.png?signature=secret");
  assert.deepEqual(requests.map((request) => request.authorization), [null, null]);
  assert.equal(images[0].source, "url");
  assert.equal(images[0].format, "png");
});

test("does not retry non-retryable download responses", async () => {
  const outputDir = temporaryDirectory();
  let requests = 0;
  await assert.rejects(
    persistImagesFromResponse({ data: [{ url: "https://cdn.example/expired.png" }] }, {
      ...options(outputDir),
      fetchImpl: async () => {
        requests += 1;
        return new Response("expired", { status: 403 });
      },
      downloadRetryDelayMs: 1
    }),
    (error) => error.code === "IMAGE_DOWNLOAD_ERROR" && error.status === 403
  );
  assert.equal(requests, 1);
});

test("rejects empty, invalid, oversized, and unwritable outputs", async () => {
  const outputDir = temporaryDirectory();
  await assert.rejects(
    persistImagesFromResponse({ data: [] }, options(outputDir)),
    (error) => error.code === "EMPTY_IMAGE_RESULT"
  );
  await assert.rejects(
    persistImagesFromResponse({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }, options(outputDir)),
    (error) => error.code === "INVALID_IMAGE_DATA"
  );
  await assert.rejects(
    persistImagesFromResponse({ data: [{ b64_json: PNG.toString("base64") }] }, { ...options(outputDir), maxOutputBytes: 8 }),
    (error) => error.code === "INVALID_IMAGE_DATA" && error.details.max_output_bytes === 8
  );

  const blockedPath = path.join(outputDir, "not-a-directory");
  fs.writeFileSync(blockedPath, "blocked");
  await assert.rejects(
    persistImagesFromResponse({ data: [{ b64_json: PNG.toString("base64") }] }, { ...options(blockedPath) }),
    (error) => error.code === "OUTPUT_WRITE_ERROR"
  );
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("detects supported image signatures and input MIME types", () => {
  assert.equal(detectImageFormat(PNG).format, "png");
  assert.equal(detectImageFormat(JPEG).format, "jpeg");
  assert.equal(detectImageFormat(WEBP).format, "webp");
  assert.equal(detectImageFormat(Buffer.from("GIF89a")), null);
  assert.equal(mimeTypeForPath("input.PNG"), "image/png");
  assert.equal(mimeTypeForPath("input.jpeg"), "image/jpeg");
  assert.equal(mimeTypeForPath("input.bin"), "application/octet-stream");
});

test("parses multi-line SSE data", () => {
  assert.deepEqual(parseSseEvent("event: sample\ndata: {\"a\": 1\ndata: ,\"b\": 2}"), {
    event: "sample",
    data: "{\"a\": 1\n,\"b\": 2}"
  });
});

test("consumes CRLF SSE across arbitrary chunks and flushes an unterminated final frame", async () => {
  const outputDir = temporaryDirectory();
  const partial = `event: image_generation.partial_image\r\ndata: {\"type\":\"image_generation.partial_image\"\r\ndata: ,\"b64_json\":\"${PNG.toString("base64")}\"}\r\n\r\n`;
  const completed = `event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"${JPEG.toString("base64")}\",\"usage\":{\"total_tokens\":7}}`;
  const response = streamResponse(chunkString(partial + completed, [1, 2, 5, 3, 8]));
  const result = await consumeImageStream(response, {
    ...options(outputDir),
    requestId: "req_stream",
    clientRequestId: "client_stream"
  });

  assert.equal(result.partial_images.length, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.partial_images[0].kind, "partial");
  assert.equal(result.images[0].kind, "final");
  assert.equal(result.images[0].format, "jpeg");
  assert.deepEqual(result.raw_usage, { total_tokens: 7 });
  assert.equal(result.request_id, "req_stream");
});

test("negotiates JSON and Images SSE from actual response content types", async () => {
  const outputDir = temporaryDirectory();
  const json = await consumeImageApiResponse(new Response(JSON.stringify({
    data: [{ b64_json: PNG.toString("base64") }],
    usage: { total_tokens: 3 }
  }), { headers: { "content-type": "application/json; charset=utf-8" } }), {
    ...options(outputDir),
    operation: "generation"
  });
  assert.equal(json.response_mode, "json");
  assert.equal(json.images.length, 1);
  assert.deepEqual(json.raw_usage, { total_tokens: 3 });

  const sseBody = `data: {"type":"image_edit.partial_image","b64_json":"${PNG.toString("base64")}"}\n\n`
    + `event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"${JPEG.toString("base64")}"}\n\n`
    + "data: [DONE]\n\n";
  const seenPartials = [];
  const sse = await consumeImageApiResponse(streamResponse([sseBody]), {
    ...options(outputDir),
    operation: "edit",
    onPartial: async (partial) => seenPartials.push(partial.path)
  });
  assert.equal(sse.response_mode, "sse");
  assert.equal(sse.partial_images.length, 1);
  assert.equal(sse.images.length, 1);
  assert.deepEqual(seenPartials, [sse.partial_images[0].path]);
});

test("accepts bounded Images lifecycle events without treating them as images", async () => {
  const outputDir = temporaryDirectory();
  const body = [
    'data: {"type":"image_generation.queued","status":"queued","task_id":"task_1"}\n\n',
    'data: {"type":"image_generation.in_progress","status":"in_progress","task_id":"task_1"}\n\n',
    `data: {"type":"image_generation.completed","b64_json":"${PNG.toString("base64")}"}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
  const result = await consumeImageApiResponse(streamResponse([body]), {
    ...options(outputDir),
    operation: "generation"
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.partial_images.length, 0);
  assert.equal(result.stream_diagnostics.event_counts["image_generation.queued"], 1);
  assert.equal(result.stream_diagnostics.event_counts["image_generation.in_progress"], 1);
});

test("accepts a bounded upstream_event_type Images wrapper", async () => {
  const outputDir = temporaryDirectory();
  const body = [
    'data: {"object":"image_generation.chunk","upstream_event_type":"image_generation.queued","data":{"status":"queued"}}\n\n',
    `data: {"object":"image_generation.chunk","upstream_event_type":"image_generation.completed","data":{"b64_json":"${PNG.toString("base64")}"}}\n\n`
  ].join("");
  const result = await consumeImageApiResponse(streamResponse([body]), {
    ...options(outputDir),
    operation: "generation"
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.stream_diagnostics.event_counts["image_generation.queued"], 1);
  assert.equal(result.stream_diagnostics.event_counts["image_generation.completed"], 1);

  await assert.rejects(
    consumeImageApiResponse(streamResponse([
      'data: {"upstream_event_type":"image_generation.completed","data":{"type":"response.completed"}}\n\n'
    ]), {
      ...options(outputDir),
      operation: "generation"
    }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
  );
});

test("sniffs JSON and SSE when response content type is missing or generic", async () => {
  const outputDir = temporaryDirectory();
  const json = await consumeImageApiResponse(new Response(JSON.stringify({
    data: [{ b64_json: PNG.toString("base64") }]
  })), { ...options(outputDir), operation: "generation" });
  assert.equal(json.response_mode, "json");

  const body = `event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"${PNG.toString("base64")}"}\n\n`;
  const sse = await consumeImageApiResponse(new Response(body, {
    headers: { "content-type": "text/plain" }
  }), { ...options(outputDir), operation: "generation" });
  assert.equal(sse.response_mode, "sse");
  assert.equal(sse.images.length, 1);
});

test("rejects Responses API and cross-operation events with safe diagnostics", async () => {
  const outputDir = temporaryDirectory();
  const secretImage = PNG.toString("base64");
  const responsesBody = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${secretImage}"}}\n\n`;
  await assert.rejects(
    consumeImageApiResponse(streamResponse([responsesBody]), {
      ...options(outputDir),
      operation: "generation",
      secret: "api-secret"
    }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
      && error.status === 200
      && error.details.last_event_type === "response.output_item.done"
      && error.details.event_counts["response.output_item.done"] === 1
      && !JSON.stringify(error.details).includes(secretImage)
      && !JSON.stringify(error.details).includes("api-secret")
  );

  const wrongPrefix = `data: {"type":"image_generation.completed","b64_json":"${secretImage}"}\n\n`;
  await assert.rejects(
    consumeImageApiResponse(streamResponse([wrongPrefix]), {
      ...options(outputDir),
      operation: "edit"
    }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
      && error.details.last_event_type === "image_generation.completed"
      && !Object.hasOwn(error.details, "operation")
  );
});

test("rejects mismatched event headers and unsupported success content types", async () => {
  const outputDir = temporaryDirectory();
  const mismatch = `event: image_generation.partial_image\ndata: {"type":"image_generation.completed","b64_json":"${PNG.toString("base64")}"}\n\n`;
  await assert.rejects(
    consumeImageApiResponse(streamResponse([mismatch]), {
      ...options(outputDir),
      operation: "generation"
    }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
  );
  await assert.rejects(
    consumeImageApiResponse(new Response("<html>ok</html>", {
      headers: { "content-type": "text/html" }
    }), { ...options(outputDir), operation: "generation" }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
      && error.details.response_content_type === "text/html"
  );
  await assert.rejects(
    consumeImageApiResponse(streamResponse([]), {
      ...options(outputDir),
      operation: "generation"
    }),
    (error) => error.code === "UPSTREAM_PROTOCOL_ERROR"
  );
});

test("reports malformed SSE with saved partial paths", async () => {
  const outputDir = temporaryDirectory();
  const body = `event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"${PNG.toString("base64")}\"}\n\nevent: image_generation.completed\ndata: {bad json}\n\n`;
  await assert.rejects(
    consumeImageStream(streamResponse([body]), options(outputDir)),
    (error) => error.code === "INVALID_IMAGE_DATA"
      && error.stage === "stream_parse"
      && error.partialImages.length === 1
      && fs.existsSync(error.partialImages[0].path)
  );
});

test("does not promote a partial image when the stream has no completed event", async () => {
  const outputDir = temporaryDirectory();
  const body = `event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"${PNG.toString("base64")}\"}\n\ndata: [DONE]\n\n`;
  await assert.rejects(
    consumeImageStream(streamResponse([body]), options(outputDir)),
    (error) => error.code === "INCOMPLETE_STREAM" && error.partialImages.length === 1
  );
});

test("reports an Images lifecycle-only stream as incomplete", async () => {
  await assert.rejects(
    consumeImageApiResponse(streamResponse([
      'data: {"type":"image_edit.queued","status":"queued","task_id":"task_1"}\n\n'
    ]), {
      ...options(temporaryDirectory()),
      operation: "edit"
    }),
    (error) => error.code === "INCOMPLETE_STREAM"
      && error.details.event_counts["image_edit.queued"] === 1
  );
});

test("surfaces explicit SSE error events", async () => {
  const outputDir = temporaryDirectory();
  const body = "event: error\ndata: {\"error\":{\"message\":\"provider failed\"}}\n\n";
  await assert.rejects(
    consumeImageStream(streamResponse([body]), options(outputDir)),
    (error) => error.code === "API_HTTP_ERROR" && error.message === "provider failed"
  );
});

test("adds client request IDs and preserves gateway and upstream request IDs", async () => {
  let clientRequestId;
  const result = await requestApiJson({
    endpoint: "https://provider.example/v1/images/generations",
    headers: { authorization: "Bearer test" },
    body: "{}",
    timeoutMs: 100,
    fetchImpl: async (_url, request) => {
      clientRequestId = request.headers.get("x-client-request-id");
      return new Response("{\"data\":[]}", {
        status: 200,
        headers: {
          "x-oneapi-request-id": "gateway_req_123",
          "x-request-id": "upstream_req_123"
        }
      });
    }
  });
  assert.match(clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(result.client_request_id, clientRequestId);
  assert.equal(result.request_id, "gateway_req_123");
  assert.equal(result.upstream_request_id, "upstream_req_123");
});

test("returns sanitized HTTP and network diagnostics", async () => {
  await assert.rejects(
    requestApiJson({
      endpoint: "https://provider.example/v1/images/generations?token=query-secret",
      timeoutMs: 100,
      secret: "api-secret",
      fetchImpl: async () => new Response('{"error":{"message":"bad api-secret"}}', {
        status: 401,
        headers: { "x-request-id": "req_error" }
      })
    }),
    (error) => error.code === "API_HTTP_ERROR"
      && error.requestId === "req_error"
      && !error.message.includes("api-secret")
  );

  await assert.rejects(
    requestApiJson({
      endpoint: "https://provider.example/v1/images/generations?token=query-secret",
      timeoutMs: 100,
      fetchImpl: async () => {
        const cause = Object.assign(new Error("dns"), { code: "ENOTFOUND", hostname: "provider.example" });
        throw Object.assign(new TypeError("fetch failed"), { cause });
      }
    }),
    (error) => error.code === "NETWORK_ERROR"
      && error.details.endpoint === "https://provider.example/v1/images/generations"
      && error.details.cause.code === "ENOTFOUND"
  );
});

test("distinguishes request timeouts and structured tool errors", async () => {
  let captured;
  await assert.rejects(
    requestApiJson({
      endpoint: "https://provider.example/v1/images/generations",
      timeoutMs: 5,
      fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })
    }),
    (error) => {
      captured = error;
      return error.code === "REQUEST_TIMEOUT" && error.stage === "api_request";
    }
  );
  const payload = toolErrorPayload(new Image2Error("incomplete", {
    code: "INCOMPLETE_STREAM",
    stage: "stream_parse",
    partialImages: [{ path: "/tmp/partial.png" }]
  }));
  assert.equal(captured.retryable, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "INCOMPLETE_STREAM");
  assert.deepEqual(payload.partial_images, [{ path: "/tmp/partial.png" }]);
});

test("keeps the API timeout active while reading the response body", async () => {
  await assert.rejects(
    requestApiJson({
      endpoint: "https://provider.example/v1/images/generations",
      timeoutMs: 5,
      fetchImpl: async (_url, request) => new Response(new ReadableStream({
        start(controller) {
          request.signal.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oneapi-request-id": "gateway_timeout",
          "x-request-id": "upstream_timeout"
        }
      })
    }),
    (error) => error.code === "REQUEST_TIMEOUT"
      && error.stage === "api_response"
      && error.requestId === "gateway_timeout"
      && error.upstreamRequestId === "upstream_timeout"
      && error.details.response_content_type === "application/json"
  );
});

test("classifies non-JSON HTTP failures as API errors", async () => {
  await assert.rejects(
    requestApiJson({
      endpoint: "https://provider.example/v1/images/generations",
      timeoutMs: 100,
      fetchImpl: async () => new Response("upstream unavailable", { status: 502 })
    }),
    (error) => error.code === "API_HTTP_ERROR" && error.status === 502 && error.retryable === true
  );
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dadaapi-image2-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function options(outputDir) {
  return {
    outputDir,
    prefix: "test",
    outputFormat: "png",
    baseUrl: "https://provider.example/v1",
    downloadTimeoutMs: 100,
    maxOutputBytes: 1024,
    requestId: "req_test",
    upstreamRequestId: "upstream_req_test",
    clientRequestId: "client_test"
  };
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkString(value, sizes) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < value.length) {
    const size = sizes[index % sizes.length];
    chunks.push(value.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}
