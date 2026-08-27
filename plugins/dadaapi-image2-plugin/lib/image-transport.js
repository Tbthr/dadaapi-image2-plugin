import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ERROR_BODY_LIMIT = 2048;
const DOWNLOAD_RETRY_DELAY_MS = 500;
const DOWNLOAD_RETRY_AFTER_CAP_MS = 5000;
const RESPONSE_SNIFF_BYTES = 4096;
const MAX_STREAM_EVENTS = 1000;

export class Image2Error extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "Image2Error";
    this.code = options.code || "CONFIG_ERROR";
    this.stage = options.stage || "plugin";
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.upstreamRequestId = options.upstreamRequestId ?? null;
    this.clientRequestId = options.clientRequestId ?? null;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
    this.partialImages = options.partialImages || null;
  }
}

export function toPublicError(error) {
  const normalized = error instanceof Image2Error
    ? error
    : new Image2Error(error?.message || String(error), {
        code: "CONFIG_ERROR",
        stage: "plugin",
        cause: error
      });
  const result = {
    code: normalized.code,
    stage: normalized.stage,
    message: normalized.message,
    status: normalized.status,
    request_id: normalized.requestId,
    upstream_request_id: normalized.upstreamRequestId,
    client_request_id: normalized.clientRequestId,
    retryable: normalized.retryable
  };
  if (normalized.details) result.details = normalized.details;
  return result;
}

export function toolErrorPayload(error) {
  const payload = {
    ok: false,
    error: toPublicError(error)
  };
  if (Array.isArray(error?.partialImages) && error.partialImages.length) {
    payload.partial_images = error.partialImages;
  }
  return payload;
}

export async function requestApiResponse({
  endpoint,
  method = "POST",
  headers = {},
  body,
  signal,
  timeoutMs,
  fetchImpl = fetch
}) {
  const clientRequestId = randomUUID();
  const requestHeaders = new Headers(headers);
  requestHeaders.set("X-Client-Request-Id", clientRequestId);
  const fetched = await fetchWithTimeout(endpoint, {
    method,
    headers: requestHeaders,
    body
  }, {
    signal,
    timeoutMs,
    fetchImpl,
    stage: "api_request",
    networkErrorCode: "NETWORK_ERROR",
    requestId: null,
    clientRequestId
  });
  const responseIds = responseRequestIds(fetched.response.headers);
  return {
    response: fetched.response,
    ...responseIds,
    client_request_id: clientRequestId,
    lifecycle: fetched.lifecycle
  };
}

export async function requestApiJson(options) {
  const result = await requestApiResponse(options);
  try {
    const json = await parseApiJsonResponse(result.response, {
      requestId: result.request_id,
      upstreamRequestId: result.upstream_request_id,
      clientRequestId: result.client_request_id,
      secret: options.secret,
      lifecycle: result.lifecycle
    });
    const { lifecycle, ...publicResult } = result;
    return { ...publicResult, json };
  } finally {
    result.lifecycle.cleanup();
  }
}

export async function parseApiJsonResponse(response, context = {}) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw networkFailure(cause, {
      lifecycle: context.lifecycle,
      code: "NETWORK_ERROR",
      stage: "api_response",
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      retryable: false,
      endpoint: response.url,
      details: responseDiagnostics(response, "")
    });
  }
  const details = responseDiagnostics(response, text);
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (cause) {
    if (!response.ok) {
      throw new Image2Error(safeProviderMessage(text, context.secret) || `Image API request failed (HTTP ${response.status}).`, {
        code: "API_HTTP_ERROR",
        stage: "api_response",
        status: response.status,
        requestId: context.requestId,
        upstreamRequestId: context.upstreamRequestId,
        clientRequestId: context.clientRequestId,
        retryable: isRetryableStatus(response.status),
        details,
        cause
      });
    }
    throw new Image2Error(`Image API returned invalid JSON (HTTP ${response.status}).`, {
      code: "INVALID_IMAGE_DATA",
      stage: "api_response",
      status: response.status,
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      details,
      cause
    });
  }

  if (!response.ok) {
    const rawMessage = json?.error?.message || json?.message || text || `${response.status} ${response.statusText}`;
    throw new Image2Error(safeProviderMessage(rawMessage, context.secret) || `Image API request failed (HTTP ${response.status}).`, {
      code: "API_HTTP_ERROR",
      stage: "api_response",
      status: response.status,
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      retryable: isRetryableStatus(response.status),
      details: {
        ...details,
        payload_keys: objectKeys(json)
      }
    });
  }
  return json;
}

export async function persistImagesFromResponse(json, options) {
  const items = Array.isArray(json?.data) ? json.data : [];
  const saved = [];
  for (const item of items) {
    const payload = imagePayloadFromItem(item);
    if (payload) saved.push(await persistImagePayload(payload, { ...options, kind: "final" }));
  }

  if (!saved.length) {
    const b64 = findBase64Image(json);
    if (b64) {
      saved.push(await persistImagePayload({ type: "base64", value: b64 }, {
        ...options,
        kind: "final"
      }));
    }
  }

  if (!saved.length) {
    throw new Image2Error("Image API returned no usable images.", {
      code: "EMPTY_IMAGE_RESULT",
      stage: "image_decode",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      retryable: false,
      details: { response_keys: objectKeys(json) }
    });
  }
  return saved;
}

export async function consumeImageApiResponse(response, options) {
  const responseContentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    await parseApiJsonResponse(response, {
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      secret: options.secret,
      lifecycle: options.lifecycle
    });
  }

  const responseMode = await detectImageResponseMode(response, options);
  if (responseMode === "sse") {
    const result = await consumeImageStream(response, {
      ...options,
      responseContentType,
      responseStatus: response.status
    });
    return {
      response_mode: "sse",
      http_status: response.status,
      response_content_type: responseContentType || null,
      ...result
    };
  }

  const json = await parseApiJsonResponse(response, {
    requestId: options.requestId,
    upstreamRequestId: options.upstreamRequestId,
    clientRequestId: options.clientRequestId,
    secret: options.secret,
    lifecycle: options.lifecycle
  });
  const images = await persistImagesFromResponse(json, options);
  return {
    response_mode: "json",
    http_status: response.status,
    response_content_type: responseContentType || null,
    partial_images: [],
    images,
    raw_usage: json?.usage || null,
    request_id: options.requestId || null,
    upstream_request_id: options.upstreamRequestId || null,
    client_request_id: options.clientRequestId || null
  };
}

export async function consumeImageStream(response, options) {
  if (!response.body) {
    throw new Image2Error("Streaming response body is empty.", {
      code: "UPSTREAM_PROTOCOL_ERROR",
      stage: "stream_parse",
      status: options.responseStatus ?? response.status,
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      retryable: false,
      details: {
        response_content_type: options.responseContentType || response.headers.get("content-type") || null,
        event_counts: {},
        last_event_type: null,
        done_seen: false,
        payload_keys: [],
        bytes_received: 0
      }
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  const partials = [];
  const finals = [];
  let rawUsage = null;
  const expectedPrefix = options.operation === "edit" ? "image_edit" : "image_generation";
  const allowedTypes = new Set([
    `${expectedPrefix}.partial_image`,
    `${expectedPrefix}.completed`
  ]);
  const lifecycleTypes = new Set([
    `${expectedPrefix}.queued`,
    `${expectedPrefix}.in_progress`
  ]);
  const diagnostics = {
    operation: options.operation === "edit" ? "edit" : "generation",
    response_content_type: options.responseContentType || response.headers.get("content-type") || null,
    event_counts: {},
    last_event_type: null,
    done_seen: false,
    partial_count: 0,
    completed_count: 0,
    payload_keys: [],
    bytes_received: 0
  };
  let eventCount = 0;
  let validImageEventCount = 0;

  const processFrames = async (frames) => {
    for (const frame of frames) {
      const event = parseSseEvent(frame);
      if (!event) continue;
      eventCount += 1;
      if (eventCount > MAX_STREAM_EVENTS) {
        throw protocolFailure("Image stream exceeded the event limit.", options, diagnostics, partials);
      }
      if (event.data.trim() === "[DONE]") {
        diagnostics.done_seen = true;
        countEvent(diagnostics, "[DONE]");
        continue;
      }

      const headerType = normalizedEventType(event.event);
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (cause) {
        const invalidType = headerType || "<invalid-json>";
        diagnostics.last_event_type = invalidType;
        countEvent(diagnostics, invalidType);
        throw new Image2Error("Image stream contained invalid JSON.", {
          code: "INVALID_IMAGE_DATA",
          stage: "stream_parse",
          status: options.responseStatus ?? response.status,
          requestId: options.requestId,
          upstreamRequestId: options.upstreamRequestId,
          clientRequestId: options.clientRequestId,
          details: streamDiagnostics(diagnostics),
          partialImages: partials,
          cause
        });
      }

      mergePayloadKeys(diagnostics, payload);
      const directPayloadType = normalizedEventType(payload?.type);
      const upstreamEventType = normalizedEventType(payload?.upstream_event_type);
      if (directPayloadType && upstreamEventType && directPayloadType !== upstreamEventType) {
        throw protocolFailure("Image stream wrapper event types do not match.", options, diagnostics, partials);
      }
      const payloadType = directPayloadType || upstreamEventType;
      const eventType = headerType || payloadType;
      diagnostics.last_event_type = eventType || null;
      countEvent(diagnostics, eventType || "<missing>");
      if (headerType && payloadType && headerType !== payloadType) {
        throw protocolFailure("Image stream event name does not match payload type.", options, diagnostics, partials);
      }
      const eventPayload = normalizedImageEventPayload(payload, eventType);
      if (!eventPayload) {
        throw protocolFailure("Image stream nested event type does not match its wrapper.", options, diagnostics, partials);
      }

      if (eventType === "error" || eventPayload?.error) {
        const message = eventPayload?.error?.message || eventPayload?.message || "Image stream returned an error event.";
        throw new Image2Error(safeProviderMessage(message, options.secret) || "Image stream returned an error event.", {
          code: "API_HTTP_ERROR",
          stage: "stream_parse",
          status: options.responseStatus ?? response.status,
          requestId: options.requestId,
          upstreamRequestId: options.upstreamRequestId,
          clientRequestId: options.clientRequestId,
          retryable: false,
          details: streamDiagnostics(diagnostics),
          partialImages: partials
        });
      }

      if (lifecycleTypes.has(eventType)) {
        if (imagePayloadFromItem(eventPayload)) {
          throw protocolFailure("Image stream lifecycle event unexpectedly contained an image payload.", options, diagnostics, partials);
        }
        validImageEventCount += 1;
        if (eventPayload?.usage) rawUsage = eventPayload.usage;
        continue;
      }

      if (!eventType || !allowedTypes.has(eventType)) {
        throw protocolFailure("Image stream contained an unsupported event type.", options, diagnostics, partials);
      }
      validImageEventCount += 1;

      if (eventPayload?.usage) rawUsage = eventPayload.usage;
      const imagePayload = imagePayloadFromItem(eventPayload);
      if (!imagePayload) {
        throw protocolFailure("Image stream event did not contain an image payload.", options, diagnostics, partials);
      }

      if (eventType.endsWith(".partial_image")) {
        const partial = await persistImagePayload(imagePayload, { ...options, kind: "partial" });
        partials.push(partial);
        diagnostics.partial_count = partials.length;
        await options.onPartial?.(partial, [...partials]);
      } else {
        finals.push(await persistImagePayload(imagePayload, { ...options, kind: "final" }));
        diagnostics.completed_count = finals.length;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      diagnostics.bytes_received += value.byteLength;
      await processFrames(parser.push(decoder.decode(value, { stream: true })));
    }
    const trailingText = decoder.decode();
    await processFrames(parser.push(trailingText));
    await processFrames(parser.finish());
  } catch (error) {
    if (error instanceof Image2Error) throw error;
    const failure = networkFailure(error, {
      lifecycle: options.lifecycle,
      code: "NETWORK_ERROR",
      stage: "stream_parse",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      retryable: false,
      endpoint: options.endpoint,
      details: streamDiagnostics(diagnostics)
    });
    failure.partialImages = partials;
    throw failure;
  }

  if (!validImageEventCount) {
    throw protocolFailure("Image stream ended without a valid Images API event.", options, diagnostics, partials);
  }

  if (!finals.length) {
    throw new Image2Error("Image stream ended without a completed image.", {
      code: "INCOMPLETE_STREAM",
      stage: "stream_parse",
      status: options.responseStatus ?? response.status,
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      retryable: false,
      details: streamDiagnostics(diagnostics),
      partialImages: partials
    });
  }

  return {
    partial_images: partials,
    images: finals,
    raw_usage: rawUsage,
    request_id: options.requestId || null,
    upstream_request_id: options.upstreamRequestId || null,
    client_request_id: options.clientRequestId || null,
    stream_diagnostics: streamDiagnostics(diagnostics)
  };
}

export function parseSseEvent(frame) {
  const event = { event: null, data: "" };
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event.event = value;
    if (field === "data") data.push(value);
  }
  event.data = data.join("\n");
  return event.data ? event : null;
}

async function detectImageResponseMode(response, options) {
  const contentType = response.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") return "sse";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";

  const sniffable = !mediaType || mediaType === "text/plain" || mediaType === "application/octet-stream";
  if (sniffable) {
    const prefix = await responsePrefix(response, RESPONSE_SNIFF_BYTES);
    const trimmed = prefix.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
    if (trimmed.startsWith("data:") || trimmed.startsWith("event:") || trimmed.startsWith(":")) return "sse";
  }

  throw new Image2Error("Image API returned an unsupported response type.", {
    code: "UPSTREAM_PROTOCOL_ERROR",
    stage: "api_response",
    status: response.status,
    requestId: options.requestId,
    upstreamRequestId: options.upstreamRequestId,
    clientRequestId: options.clientRequestId,
    retryable: false,
    details: {
      operation: options.operation === "edit" ? "edit" : "generation",
      response_content_type: contentType || null
    }
  });
}

async function responsePrefix(response, limit) {
  if (!response.body) return "";
  const clone = response.clone();
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/^\s*(?:[\[{]|data:|event:|:)/.test(text)) break;
    }
    text += decoder.decode();
    return text.slice(0, limit);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function normalizedEventType(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizedImageEventPayload(payload, eventType) {
  const nested = payload?.data;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return payload;
  const nestedType = normalizedEventType(nested.type);
  if (nestedType && nestedType !== eventType) return null;
  return { ...nested, type: eventType };
}

function countEvent(diagnostics, eventType) {
  diagnostics.event_counts[eventType] = (diagnostics.event_counts[eventType] || 0) + 1;
}

function mergePayloadKeys(diagnostics, payload) {
  const keys = objectKeys(payload);
  for (const key of keys) {
    if (!diagnostics.payload_keys.includes(key) && diagnostics.payload_keys.length < 20) {
      diagnostics.payload_keys.push(key);
    }
  }
}

function streamDiagnostics(diagnostics) {
  return {
    response_content_type: diagnostics.response_content_type,
    event_counts: { ...diagnostics.event_counts },
    last_event_type: diagnostics.last_event_type,
    done_seen: diagnostics.done_seen,
    payload_keys: [...diagnostics.payload_keys],
    bytes_received: diagnostics.bytes_received
  };
}

function protocolFailure(message, options, diagnostics, partialImages) {
  return new Image2Error(message, {
    code: "UPSTREAM_PROTOCOL_ERROR",
    stage: "stream_parse",
    status: options.responseStatus ?? null,
    requestId: options.requestId,
    upstreamRequestId: options.upstreamRequestId,
    clientRequestId: options.clientRequestId,
    retryable: false,
    details: streamDiagnostics(diagnostics),
    partialImages
  });
}

function responseDiagnostics(response, text) {
  return {
    response_content_type: response.headers.get("content-type") || null,
    payload_keys: [],
    bytes_received: Buffer.byteLength(text || "", "utf8")
  };
}

function safeProviderMessage(value, secret) {
  let message = redactAndTruncate(value, secret, 500);
  if (!message) return "";
  message = message
    .replace(/\b(?:sk|sess|key|token)-[A-Za-z0-9_-]{16,}\b/gi, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "<redacted-base64>");
  return truncate(message, 500);
}

export function detectImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "png", extension: "png", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: "jpeg", extension: "jpg", mime: "image/jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { format: "webp", extension: "webp", mime: "image/webp" };
  }
  return null;
}

export function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "application/octet-stream";
}

export function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function responseRequestIds(headers) {
  const gatewayRequestId = headers.get("x-oneapi-request-id") || null;
  const providerRequestId = headers.get("x-request-id") || null;
  return {
    request_id: gatewayRequestId || providerRequestId,
    upstream_request_id: gatewayRequestId && providerRequestId && providerRequestId !== gatewayRequestId
      ? providerRequestId
      : null
  };
}

async function persistImagePayload(payload, options) {
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  let bytes;
  let source;
  if (payload.type === "url") {
    bytes = await downloadImage(payload.value, { ...options, maxOutputBytes });
    source = "url";
  } else {
    bytes = decodeBase64Image(payload.value, maxOutputBytes, options);
    source = "base64";
  }

  const detected = detectImageFormat(bytes);
  if (!detected) {
    throw new Image2Error("Image response is not a supported PNG, JPEG, or WebP file.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_decode",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      details: { bytes: bytes.length, source }
    });
  }

  const filePath = atomicWriteImage(bytes, detected.extension, options);
  return {
    path: filePath,
    kind: options.kind || "final",
    format: detected.format,
    source,
    bytes: bytes.length
  };
}

function imagePayloadFromItem(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.b64_json === "string") return { type: "base64", value: item.b64_json };
  for (const key of ["image", "data"]) {
    if (typeof item[key] === "string" && (item[key].startsWith("data:") || looksLikeBase64(item[key]))) {
      return { type: "base64", value: item[key] };
    }
  }
  if (typeof item.url === "string") {
    return item.url.startsWith("data:")
      ? { type: "base64", value: item.url }
      : { type: "url", value: item.url };
  }
  return null;
}

function decodeBase64Image(value, maxOutputBytes, context) {
  let encoded = String(value || "").trim();
  if (encoded.startsWith("data:")) {
    const match = encoded.match(/^data:[^,]*;base64,([\s\S]+)$/i);
    if (!match) {
      throw new Image2Error("Image API returned an unsupported data URL.", {
        code: "INVALID_IMAGE_DATA",
        stage: "image_decode",
        requestId: context.requestId,
        upstreamRequestId: context.upstreamRequestId,
        clientRequestId: context.clientRequestId
      });
    }
    encoded = match[1];
  }
  encoded = encoded.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Image2Error("Image API returned invalid base64 image data.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_decode",
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId
    });
  }
  if (encoded.length > Math.ceil(maxOutputBytes / 3) * 4 + 4) {
    throw outputTooLarge(maxOutputBytes, context);
  }
  const padding = encoded.length % 4;
  if (padding) encoded += "=".repeat(4 - padding);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) {
    throw new Image2Error("Image response was empty.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_decode",
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId
    });
  }
  if (bytes.length > maxOutputBytes) throw outputTooLarge(maxOutputBytes, context);
  return bytes;
}

async function downloadImage(value, options) {
  let target;
  try {
    target = new URL(value, `${options.baseUrl.replace(/\/+$/, "")}/`);
  } catch (cause) {
    throw new Image2Error("Image API returned an invalid download URL.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_download",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      cause
    });
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Image2Error("Image download URL must use HTTP or HTTPS.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_download",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      details: { url: safeEndpoint(target) }
    });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fetched = null;
    try {
      fetched = await fetchWithTimeout(target, {
        method: "GET",
        headers: {
          accept: "image/png,image/jpeg,image/webp,image/*;q=0.8,*/*;q=0.1"
        }
      }, {
        signal: options.signal,
        timeoutMs: options.downloadTimeoutMs,
        fetchImpl: options.fetchImpl || fetch,
        stage: "image_download",
        networkErrorCode: "IMAGE_DOWNLOAD_ERROR",
        requestId: options.requestId,
        upstreamRequestId: options.upstreamRequestId,
        clientRequestId: options.clientRequestId
      });
      const response = fetched.response;

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        if (attempt === 0 && retryable) {
          const delayMs = retryDelayMs(response.headers.get("retry-after"), options.downloadRetryDelayMs);
          fetched.lifecycle.cleanup();
          fetched = null;
          await sleep(delayMs, options.signal);
          continue;
        }
        throw new Image2Error(`Image download failed (HTTP ${response.status}).`, {
          code: "IMAGE_DOWNLOAD_ERROR",
          stage: "image_download",
          status: response.status,
          requestId: options.requestId,
          upstreamRequestId: options.upstreamRequestId,
          clientRequestId: options.clientRequestId,
          retryable,
          details: { url: safeEndpoint(target) }
        });
      }
      return await readResponseBytes(response, options.maxOutputBytes, options);
    } catch (error) {
      const normalized = error instanceof Image2Error
        ? error
        : networkFailure(error, {
            lifecycle: fetched?.lifecycle,
            code: "IMAGE_DOWNLOAD_ERROR",
            stage: "image_download",
            requestId: options.requestId,
            upstreamRequestId: options.upstreamRequestId,
            clientRequestId: options.clientRequestId,
            retryable: true,
            endpoint: target
          });
      const retryable = ["IMAGE_DOWNLOAD_ERROR", "REQUEST_TIMEOUT"].includes(normalized.code)
        && normalized.status !== 403;
      if (attempt === 0 && retryable) {
        await sleep(positiveInteger(options.downloadRetryDelayMs, DOWNLOAD_RETRY_DELAY_MS), options.signal);
        continue;
      }
      throw normalized;
    } finally {
      fetched?.lifecycle.cleanup();
    }
  }
  throw new Image2Error("Image download failed.", {
    code: "IMAGE_DOWNLOAD_ERROR",
    stage: "image_download",
    requestId: options.requestId,
    upstreamRequestId: options.upstreamRequestId,
    clientRequestId: options.clientRequestId
  });
}

async function readResponseBytes(response, maxOutputBytes, context) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxOutputBytes) {
    throw outputTooLarge(maxOutputBytes, context);
  }
  if (!response.body) {
    throw new Image2Error("Image download response body was empty.", {
      code: "IMAGE_DOWNLOAD_ERROR",
      stage: "image_download",
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOutputBytes) {
      await reader.cancel();
      throw outputTooLarge(maxOutputBytes, context);
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) {
    throw new Image2Error("Image download response was empty.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_decode",
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId
    });
  }
  return Buffer.concat(chunks, total);
}

function atomicWriteImage(bytes, extension, options) {
  const safePrefix = String(options.prefix || "image2").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${safePrefix}-${options.kind || "final"}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  const filePath = path.join(options.outputDir, filename);
  const temporaryPath = `${filePath}.${randomUUID().slice(0, 8)}.part`;
  try {
    fs.mkdirSync(options.outputDir, { recursive: true });
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    return filePath;
  } catch (cause) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Image2Error("Failed to save the generated image.", {
      code: "OUTPUT_WRITE_ERROR",
      stage: "image_persist",
      requestId: options.requestId,
      upstreamRequestId: options.upstreamRequestId,
      clientRequestId: options.clientRequestId,
      details: { directory: options.outputDir, cause: causeDetails(cause) },
      cause
    });
  }
}

async function fetchWithTimeout(url, requestOptions, context) {
  const lifecycle = createRequestLifecycle(context.signal, context.timeoutMs);
  try {
    const response = await context.fetchImpl(url, { ...requestOptions, signal: lifecycle.signal });
    return { response, lifecycle };
  } catch (cause) {
    lifecycle.cleanup();
    throw networkFailure(cause, {
      lifecycle,
      code: context.networkErrorCode,
      stage: context.stage,
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      retryable: context.stage === "image_download",
      endpoint: url
    });
  }
}

function createRequestLifecycle(externalSignal, timeoutValue) {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timeoutMs = positiveInteger(timeoutValue, 300000);
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  let cleaned = false;
  return {
    signal: controller.signal,
    timeoutMs,
    externalSignal,
    get timedOut() {
      return state.timedOut;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function networkFailure(cause, context) {
  if (context.lifecycle?.timedOut) {
    return new Image2Error(`Request timed out after ${context.lifecycle.timeoutMs}ms.`, {
      code: "REQUEST_TIMEOUT",
      stage: context.stage,
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      retryable: context.retryable,
      details: { ...(context.details || {}), endpoint: safeEndpoint(context.endpoint), cause: causeDetails(cause) },
      cause
    });
  }
  if (context.lifecycle?.externalSignal?.aborted) {
    return new Image2Error("Request was cancelled.", {
      code: "CANCELLED",
      stage: context.stage,
      requestId: context.requestId,
      upstreamRequestId: context.upstreamRequestId,
      clientRequestId: context.clientRequestId,
      cause
    });
  }
  const message = context.stage === "image_download"
    ? "Image download network request failed."
    : context.stage === "stream_parse"
      ? "Failed while reading the image stream."
      : context.stage === "api_response"
        ? "Failed while reading the Image API response."
        : "Image API network request failed.";
  return new Image2Error(message, {
    code: context.code,
    stage: context.stage,
    requestId: context.requestId,
    upstreamRequestId: context.upstreamRequestId,
    clientRequestId: context.clientRequestId,
    retryable: context.retryable,
    details: { ...(context.details || {}), endpoint: safeEndpoint(context.endpoint), cause: causeDetails(cause) },
    cause
  });
}

class SseFrameParser {
  constructor() {
    this.buffer = "";
  }

  push(text) {
    this.buffer += text;
    const frames = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      frames.push(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }
    return frames;
  }

  finish() {
    const trailing = this.buffer.trim();
    this.buffer = "";
    return trailing ? [trailing] : [];
  }
}

function findBase64Image(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.b64_json === "string") return value.b64_json;
  if (typeof value.image === "string" && looksLikeBase64(value.image)) return value.image;
  if (typeof value.data === "string" && looksLikeBase64(value.data)) return value.data;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findBase64Image(item);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findBase64Image(child);
      if (found) return found;
    }
  }
  return null;
}

function looksLikeBase64(text) {
  const compact = text.replace(/\s/g, "");
  return compact.length >= 12 && /^[A-Za-z0-9+/=_-]+$/.test(compact);
}

function outputTooLarge(maxOutputBytes, context) {
  return new Image2Error(`Image output exceeds the ${maxOutputBytes} byte limit.`, {
    code: "INVALID_IMAGE_DATA",
    stage: "image_decode",
    requestId: context.requestId,
    upstreamRequestId: context.upstreamRequestId,
    clientRequestId: context.clientRequestId,
    details: { max_output_bytes: maxOutputBytes }
  });
}

function retryDelayMs(retryAfter, fallback) {
  const defaultDelay = positiveInteger(fallback, DOWNLOAD_RETRY_DELAY_MS);
  if (!retryAfter) return defaultDelay;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(DOWNLOAD_RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return defaultDelay;
  return Math.min(DOWNLOAD_RETRY_AFTER_CAP_MS, Math.max(0, dateMs - Date.now()));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function objectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).slice(0, 20) : [];
}

function redactAndTruncate(value, secret, limit = ERROR_BODY_LIMIT) {
  let text = String(value || "");
  if (secret) text = text.split(secret).join("<redacted>");
  return truncate(text, limit);
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function causeDetails(error) {
  const cause = error?.cause || error;
  const details = {};
  for (const key of ["code", "errno", "syscall", "hostname"]) {
    if (cause?.[key] !== undefined) details[key] = String(cause[key]);
  }
  return Object.keys(details).length ? details : null;
}

async function sleep(ms, signal) {
  if (signal?.aborted) {
    throw new Image2Error("Request was cancelled.", {
      code: "CANCELLED",
      stage: "image_download"
    });
  }
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Image2Error("Request was cancelled.", {
        code: "CANCELLED",
        stage: "image_download"
      }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
