import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ERROR_BODY_LIMIT = 2048;
const DOWNLOAD_RETRY_DELAY_MS = 500;
const DOWNLOAD_RETRY_AFTER_CAP_MS = 5000;

export class Image2Error extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "Image2Error";
    this.code = options.code || "CONFIG_ERROR";
    this.stage = options.stage || "plugin";
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
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
  return {
    response: fetched.response,
    request_id: fetched.response.headers.get("x-request-id"),
    client_request_id: clientRequestId,
    lifecycle: fetched.lifecycle
  };
}

export async function requestApiJson(options) {
  const result = await requestApiResponse(options);
  try {
    const json = await parseApiJsonResponse(result.response, {
      requestId: result.request_id,
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
      clientRequestId: context.clientRequestId,
      retryable: false,
      endpoint: response.url
    });
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (cause) {
    if (!response.ok) {
      throw new Image2Error(redactAndTruncate(text || `${response.status} ${response.statusText}`, context.secret, 500), {
        code: "API_HTTP_ERROR",
        stage: "api_response",
        status: response.status,
        requestId: context.requestId,
        clientRequestId: context.clientRequestId,
        retryable: isRetryableStatus(response.status),
        details: { response: redactAndTruncate(text, context.secret) },
        cause
      });
    }
    throw new Image2Error(`Image API returned invalid JSON (HTTP ${response.status}).`, {
      code: "INVALID_IMAGE_DATA",
      stage: "api_response",
      status: response.status,
      requestId: context.requestId,
      clientRequestId: context.clientRequestId,
      details: { response: redactAndTruncate(text, context.secret) },
      cause
    });
  }

  if (!response.ok) {
    const rawMessage = json?.error?.message || json?.message || text || `${response.status} ${response.statusText}`;
    throw new Image2Error(redactAndTruncate(rawMessage, context.secret, 500), {
      code: "API_HTTP_ERROR",
      stage: "api_response",
      status: response.status,
      requestId: context.requestId,
      clientRequestId: context.clientRequestId,
      retryable: isRetryableStatus(response.status),
      details: { response: redactAndTruncate(text, context.secret) }
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
      clientRequestId: options.clientRequestId,
      retryable: false,
      details: { response_keys: objectKeys(json) }
    });
  }
  return saved;
}

export async function consumeImageStream(response, options) {
  if (!response.body) {
    throw new Image2Error("Streaming response body is empty.", {
      code: "INCOMPLETE_STREAM",
      stage: "stream_parse",
      requestId: options.requestId,
      clientRequestId: options.clientRequestId
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  const partials = [];
  const finals = [];
  let rawUsage = null;

  const processFrames = async (frames) => {
    for (const frame of frames) {
      const event = parseSseEvent(frame);
      if (!event || event.data === "[DONE]") continue;

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (cause) {
        throw new Image2Error("Image stream contained invalid JSON.", {
          code: "INVALID_IMAGE_DATA",
          stage: "stream_parse",
          requestId: options.requestId,
          clientRequestId: options.clientRequestId,
          details: { event: event.event, data: truncate(event.data, 500) },
          partialImages: partials,
          cause
        });
      }

      if (event.event === "error" || payload?.error) {
        const message = payload?.error?.message || payload?.message || "Image stream returned an error event.";
        throw new Image2Error(truncate(String(message), 500), {
          code: "API_HTTP_ERROR",
          stage: "stream_parse",
          requestId: options.requestId,
          clientRequestId: options.clientRequestId,
          retryable: false,
          partialImages: partials
        });
      }

      if (payload?.usage) rawUsage = payload.usage;
      const eventType = `${event.event || ""} ${payload?.type || ""}`.toLowerCase();
      const imagePayload = imagePayloadFromItem(payload);
      if (!imagePayload) continue;

      if (eventType.includes("partial")) {
        partials.push(await persistImagePayload(imagePayload, { ...options, kind: "partial" }));
      } else if (eventType.includes("completed")) {
        finals.push(await persistImagePayload(imagePayload, { ...options, kind: "final" }));
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
      clientRequestId: options.clientRequestId,
      retryable: false,
      endpoint: options.endpoint
    });
    failure.partialImages = partials;
    throw failure;
  }

  if (!finals.length) {
    throw new Image2Error("Image stream ended without a completed image.", {
      code: "INCOMPLETE_STREAM",
      stage: "stream_parse",
      requestId: options.requestId,
      clientRequestId: options.clientRequestId,
      retryable: false,
      partialImages: partials
    });
  }

  return {
    partial_images: partials,
    images: finals,
    raw_usage: rawUsage,
    request_id: options.requestId || null,
    client_request_id: options.clientRequestId || null
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
      clientRequestId: options.clientRequestId,
      cause
    });
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Image2Error("Image download URL must use HTTP or HTTPS.", {
      code: "INVALID_IMAGE_DATA",
      stage: "image_download",
      requestId: options.requestId,
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
      clientRequestId: context.clientRequestId,
      retryable: context.retryable,
      details: { endpoint: safeEndpoint(context.endpoint), cause: causeDetails(cause) },
      cause
    });
  }
  if (context.lifecycle?.externalSignal?.aborted) {
    return new Image2Error("Request was cancelled.", {
      code: "CANCELLED",
      stage: context.stage,
      requestId: context.requestId,
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
    clientRequestId: context.clientRequestId,
    retryable: context.retryable,
    details: { endpoint: safeEndpoint(context.endpoint), cause: causeDetails(cause) },
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
