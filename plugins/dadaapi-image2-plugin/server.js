#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Image2Error,
  consumeImageApiResponse,
  mimeTypeForPath,
  requestApiJson,
  requestApiResponse,
  safeEndpoint,
  toPublicError,
  toolErrorPayload
} from "./lib/image-transport.js";

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.join(SERVER_ROOT, "assets");
const JOBS_DIR = path.join(SERVER_ROOT, "jobs");
const INPUT_CACHE_DIR = path.join(SERVER_ROOT, "input-cache");
const ASSETS_FILE = path.join(SERVER_ROOT, "assets.json");
const DEFAULT_ENV_FILE = path.join(os.homedir(), ".codex", "image2-mcp.env");
const IMAGE2_QUALITIES = new Set(["auto", "high", "medium", "low"]);
const BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const MODERATIONS = new Set(["auto", "low"]);
const MAX_PARTIAL_IMAGES = 3;
const DEFAULT_MAX_INPUT_BYTES = 18 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INPUT_LONG_EDGE = 1536;
const DEFAULT_INPUT_COMPRESSION_QUALITY = 82;
const jobs = new Map();
const registeredAssets = loadAssetRegistry();

loadEnvFile(process.env.IMAGE2_ENV_FILE || DEFAULT_ENV_FILE);

const apiKey = process.env.IMAGE2_API_KEY;
const baseUrl = normalizeBaseUrl(process.env.IMAGE2_BASE_URL || "https://dadaapi.com");
const defaultModel = process.env.IMAGE2_MODEL || "gpt-image-2";
const defaultOutputDir = expandHome(process.env.IMAGE2_DEFAULT_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
const requestTimeoutMs = positiveIntegerEnv("IMAGE2_REQUEST_TIMEOUT_MS", 300000);
const downloadTimeoutMs = positiveIntegerEnv("IMAGE2_DOWNLOAD_TIMEOUT_MS", 60000);
const maxOutputBytes = positiveIntegerEnv("IMAGE2_MAX_OUTPUT_BYTES", 32 * 1024 * 1024);

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(INPUT_CACHE_DIR, { recursive: true });

const inputBudgetFields = {
  image_asset_ids: z.array(z.string()).max(8).optional().describe("Previously registered Image2 asset ids to use as input references. Prefer this over re-sending old image context."),
  input_preprocessing: z.boolean().default(true).describe("Downsample or compress local input images only when they exceed the configured dimensions or byte budget."),
  max_input_bytes: z.number().int().min(256 * 1024).max(100 * 1024 * 1024).default(DEFAULT_MAX_INPUT_BYTES).describe("Maximum total prepared image bytes allowed for one edit request."),
  max_single_input_bytes: z.number().int().min(128 * 1024).max(50 * 1024 * 1024).default(DEFAULT_MAX_SINGLE_INPUT_BYTES).describe("Target maximum bytes for each prepared input image."),
  max_input_long_edge: z.number().int().min(256).max(4096).default(DEFAULT_MAX_INPUT_LONG_EDGE).describe("Maximum long edge for prepared input images."),
  input_compression_quality: z.number().int().min(40).max(100).default(DEFAULT_INPUT_COMPRESSION_QUALITY).describe("JPEG compression quality for prepared opaque input images."),
  preserve_alpha: z.boolean().default(true).describe("Preserve alpha channels when an input image must be resized or converted.")
};

const commonFields = {
  prompt: z.string().min(1).describe("Image prompt. Keep text-heavy content out of images when the asset will be placed into editable PPTX."),
  model: z.string().default(defaultModel).describe("Image model name. Default comes from IMAGE2_MODEL, normally gpt-image-2. Do not override it unless the user explicitly asks for another model."),
  size: z.string().default("auto").describe("Output size: auto or WIDTHxHEIGHT within GPT Image2 edge, ratio, divisibility, and pixel-count limits."),
  quality: z.enum(["auto", "high", "medium", "low"]).default("auto").describe("Rendering quality. Higher quality can cost more and take longer."),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto").describe("Background mode. GPT Image2 transparent output is a preview feature and requires png or webp."),
  output_format: z.enum(["png", "jpeg", "webp"]).default("png").describe("Output image format. Use png for PPT assets unless file size matters."),
  moderation: z.enum(["auto", "low"]).default("auto").describe("Moderation strictness where supported by the provider."),
  output_compression: z.number().int().min(0).max(100).optional().describe("Compression level for jpeg/webp where supported; ignored for png by many providers."),
  n: z.number().int().min(1).max(10).default(1).describe("Number of final images to request."),
  output_dir: z.string().optional().describe("Directory where generated images should be saved. Defaults to IMAGE2_DEFAULT_OUTPUT_DIR."),
  filename_prefix: z.string().regex(/^[a-zA-Z0-9._-]+$/).default("image2").describe("Safe prefix for saved image filenames."),
  stream: z.boolean().default(false).describe("Use streaming image generation when supported. Saves partial images and final images."),
  partial_images: z.number().int().min(0).max(MAX_PARTIAL_IMAGES).default(0).describe("Number of partial images to request with stream=true. Official range is 0-3."),
  extra: z.record(z.unknown()).optional().describe("Provider-specific passthrough parameters. stream and partial_images are reserved; other matching fields are revalidated after override.")
};

const generateSchema = z.object(commonFields);

const editSchema = z.object({
  ...commonFields,
  ...inputBudgetFields,
  image_paths: z.array(z.string()).max(8).optional().describe("Input image file paths to edit. Prefer image_asset_ids for images already used in this thread."),
  mask_path: z.string().optional().describe("Optional mask image path for compatible OpenAI-style APIs.")
});

const registerAssetSchema = z.object({
  image_path: z.string().min(1).describe("Local image path to register as a reusable Image2 asset."),
  name: z.string().optional().describe("Short human-readable name for the asset."),
  description: z.string().max(1000).optional().describe("Brief description used for lightweight context. Do not include base64 or long OCR dumps."),
  tags: z.array(z.string()).max(16).optional().describe("Optional lightweight tags for later lookup.")
});

const elementSpecSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1).describe("Short element name used in filenames."),
    description: z.string().optional().describe("How to identify this element in the source image."),
    prompt: z.string().optional().describe("Element-specific extraction instructions.")
  })
]);

const extractElementsSchema = z.object({
  image_path: z.string().min(1).describe("Flattened source design image to split into reusable assets."),
  ...inputBudgetFields,
  elements: z.array(elementSpecSchema).min(1).max(24).describe("Elements to isolate. Provide names or objects with name/description/prompt."),
  include_background: z.boolean().default(false).describe("Also recreate the underlying background/backdrop as a separate asset."),
  prompt_prefix: z.string().optional().describe("Shared extra instructions applied to every element extraction."),
  model: z.string().default(defaultModel).describe("Image model name. Default comes from IMAGE2_MODEL, normally gpt-image-2. Do not override it unless the user explicitly asks for another model."),
  size: z.string().default("auto").describe("Output size. Official presets are auto, 1024x1024, 1024x1536, 1536x1024. Custom sizes may be accepted by compatible providers if they meet provider constraints."),
  quality: z.enum(["auto", "high", "medium", "low"]).default("auto").describe("Rendering quality. Higher quality can cost more and take longer."),
  output_format: z.enum(["png", "webp"]).default("png").describe("Output image format for opaque element images. GPT Image2 does not support transparent alpha output."),
  moderation: z.enum(["auto", "low"]).default("auto").describe("Moderation strictness where supported by the provider."),
  output_compression: z.number().int().min(0).max(100).optional().describe("Compression level for webp where supported; ignored for png by many providers."),
  n: z.number().int().min(1).max(4).default(1).describe("Number of variants to request for each extracted element."),
  output_dir: z.string().optional().describe("Directory where extracted assets should be saved. Defaults to IMAGE2_DEFAULT_OUTPUT_DIR."),
  filename_prefix: z.string().regex(/^[a-zA-Z0-9._-]+$/).default("image2-elements").describe("Safe prefix for saved image filenames."),
  extra: z.record(z.unknown()).optional().describe("Provider-specific passthrough parameters. Values here override matching top-level request fields.")
});

const startSchema = z.object({
  ...commonFields,
  job_name: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional().describe("Optional human-readable job name for saved metadata.")
});

const getJobSchema = z.object({
  job_id: z.string().min(1).describe("Job id returned by image2_start_generation.")
});

const cancelJobSchema = z.object({
  job_id: z.string().min(1).describe("Job id returned by image2_start_generation.")
});

const doctorSchema = z.object({
  network: z.boolean().default(true).describe("Also check API connectivity and model visibility without generating an image.")
});

const server = new McpServer({
  name: "DadaAPI Image2",
  version: "0.1.0"
});

server.tool(
  "image2_generate",
  "Generate GPT Image compatible assets and save them to disk. Supports optional streaming partial images.",
  generateSchema.shape,
  withToolErrors(async (args) => {
    const result = await generateImages(args);
    return jsonToolResult(result);
  })
);

server.tool(
  "image2_edit",
  "Edit one or more images with a GPT Image compatible API and save the outputs to disk. Supports Images API JSON or SSE responses.",
  editSchema.shape,
  withToolErrors(async (args) => {
    const result = await editImages(args);
    return jsonToolResult(result);
  })
);

server.tool(
  "image2_doctor",
  "Check Image2 configuration, output directory access, API connectivity, and model visibility without generating an image.",
  doctorSchema.shape,
  withToolErrors(async (args) => jsonToolResult(await runDoctor(args)))
);

server.tool(
  "image2_register_asset",
  "Register a local image as a reusable lightweight Image2 asset. Future edits can pass image_asset_ids instead of repeating historical image context.",
  registerAssetSchema.shape,
  withToolErrors(async (args) => {
    const result = registerImageAsset(args);
    return jsonToolResult(result);
  })
);

server.tool(
  "image2_extract_elements",
  "Use Image2 image editing to isolate or recreate described subjects/elements from a source image as intentionally opaque PNG/WebP assets.",
  extractElementsSchema.shape,
  withToolErrors(async (args) => {
    const result = await extractDesignElements(args);
    return jsonToolResult(result);
  })
);

server.tool(
  "image2_start_generation",
  "Start a background image generation job. Streaming jobs expose saved partial images through image2_get_job while still running.",
  startSchema.shape,
  withToolErrors(async (args) => {
    const jobId = randomUUID();
    const controller = new AbortController();
    const now = new Date().toISOString();
    const record = {
      job_id: jobId,
      job_name: args.job_name || null,
      status: "running",
      created_at: now,
      updated_at: now,
      request: sanitizeForRecord(args),
      partial_images: [],
      result: null,
      error: null,
      controller
    };

    jobs.set(jobId, record);
    writeJob(record);

    generateImages(args, controller.signal, async (_partial, partialImages) => {
      updateJob(jobId, { partial_images: partialImages });
    })
      .then((result) => {
        updateJob(jobId, { status: "completed", result });
      })
      .catch((error) => {
        const publicError = toPublicError(error);
        updateJob(jobId, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          error: publicError,
          ...(Array.isArray(error?.partialImages) && error.partialImages.length
            ? { partial_images: error.partialImages }
            : {})
        });
      });

    return jsonToolResult({
      job_id: jobId,
      status: "running",
      message: "Generation started. Poll with image2_get_job."
    });
  })
);

server.tool(
  "image2_get_job",
  "Get the current state and saved output paths for a background image generation job.",
  getJobSchema.shape,
  withToolErrors(async ({ job_id }) => {
    const record = jobs.get(job_id) || readJob(job_id);
    if (!record) {
      throw new Error(`Unknown job_id: ${job_id}`);
    }
    return jsonToolResult(publicJob(record));
  })
);

server.tool(
  "image2_cancel_job",
  "Cancel a running background image generation job.",
  cancelJobSchema.shape,
  withToolErrors(async ({ job_id }) => {
    const record = jobs.get(job_id);
    if (!record) {
      const saved = readJob(job_id);
      if (!saved) throw new Error(`Unknown job_id: ${job_id}`);
      return jsonToolResult(publicJob(saved));
    }
    if (record.status === "running") {
      record.controller.abort();
      updateJob(job_id, { status: "cancelled" });
    }
    return jsonToolResult(publicJob(jobs.get(job_id)));
  })
);

if (!apiKey) {
  console.error("IMAGE2_API_KEY is not configured. Set it in ~/.codex/image2-mcp.env.");
}

await server.connect(new StdioServerTransport());

async function generateImages(args, signal, onPartial) {
  assertConfigured();
  const outputDir = ensureOutputDir(args.output_dir);
  const request = buildJsonRequest(args);
  const endpoint = `${baseUrl}/images/generations`;
  return requestImages({
    operation: "generation",
    args,
    request,
    endpoint,
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(request),
    signal,
    outputDir,
    onPartial
  });
}

async function runDoctor(args) {
  const checks = [];
  const addCheck = (name, status, message) => checks.push({ name, status, message });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  addCheck(
    "node",
    nodeMajor >= 20 ? "pass" : "fail",
    `Node ${process.versions.node}; version 20 or newer is required.`
  );
  addCheck(
    "configuration",
    apiKey ? "pass" : "fail",
    apiKey ? "IMAGE2_API_KEY is configured." : "IMAGE2_API_KEY is not configured in ~/.codex/image2-mcp.env."
  );

  try {
    const outputDir = ensureOutputDir();
    const probe = path.join(outputDir, `.image2-doctor-${randomUUID()}.tmp`);
    fs.writeFileSync(probe, "ok", { flag: "wx" });
    fs.unlinkSync(probe);
    addCheck("output_directory", "pass", `Output directory is writable: ${outputDir}`);
  } catch (error) {
    addCheck("output_directory", "fail", `Output directory is not writable: ${error.message}`);
  }

  let requestId = null;
  let upstreamRequestId = null;
  let clientRequestId = null;
  if (!args.network) {
    addCheck("api", "warn", "Network checks were skipped by request.");
  } else if (!apiKey) {
    addCheck("api", "warn", "API checks were skipped because IMAGE2_API_KEY is missing.");
  } else {
    try {
      const result = await requestApiJson({
        endpoint: `${baseUrl}/models`,
        method: "GET",
        headers: authHeaders(),
        timeoutMs: 15000,
        secret: apiKey
      });
      requestId = result.request_id;
      upstreamRequestId = result.upstream_request_id;
      clientRequestId = result.client_request_id;
      const models = Array.isArray(result.json?.data)
        ? result.json.data.map((item) => item?.id).filter(Boolean)
        : null;
      if (!models) {
        addCheck("api", "warn", "The models endpoint responded but did not return a model list.");
      } else if (models.includes(defaultModel)) {
        addCheck("api", "pass", `Model ${defaultModel} is visible to this API key.`);
      } else {
        addCheck("api", "fail", `Model ${defaultModel} is not visible to this API key.`);
      }
    } catch (error) {
      const publicError = toPublicError(error);
      requestId = publicError.request_id;
      upstreamRequestId = publicError.upstream_request_id;
      clientRequestId = publicError.client_request_id;
      if ([404, 405, 501].includes(publicError.status)) {
        addCheck("api", "warn", "The provider does not support the models endpoint; generation was not attempted.");
      } else {
        addCheck("api", "fail", `${publicError.code}: ${publicError.message}`);
      }
    }
  }

  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";
  return {
    status,
    checks,
    base_url: safeEndpoint(baseUrl),
    model: defaultModel,
    request_id: requestId,
    upstream_request_id: upstreamRequestId,
    client_request_id: clientRequestId
  };
}

async function extractDesignElements(args, signal) {
  assertConfigured();
  const outputDir = ensureOutputDir(args.output_dir);
  const elements = args.elements.map(normalizeElementSpec);
  const extracted = [];
  const sourceProxy = await prepareInputImage(args.image_path, args);

  for (const element of elements) {
    const editArgs = {
      model: args.model,
      prompt: buildElementExtractionPrompt(element, args.prompt_prefix),
      size: args.size,
      quality: args.quality,
      background: "opaque",
      output_format: args.output_format,
      moderation: args.moderation,
      output_compression: args.output_compression,
      n: args.n,
      output_dir: outputDir,
      filename_prefix: `${args.filename_prefix}-${slugifyFilename(element.name)}`,
      image_paths: [sourceProxy.path],
      input_preprocessing: false,
      max_input_bytes: args.max_input_bytes,
      max_single_input_bytes: args.max_single_input_bytes,
      max_input_long_edge: args.max_input_long_edge,
      input_compression_quality: args.input_compression_quality,
      preserve_alpha: args.preserve_alpha,
      extra: args.extra
    };

    const result = await editImages(editArgs, signal);
    extracted.push({
      name: element.name,
      description: element.description || null,
      prompt: editArgs.prompt,
      alpha_output: "unsupported_by_gpt_image2",
      background_mode: "opaque",
      images: result.images
    });
  }

  let background = null;
  if (args.include_background) {
    const backgroundArgs = {
      model: args.model,
      prompt: buildBackgroundExtractionPrompt(args.prompt_prefix),
      size: args.size,
      quality: args.quality,
      background: "opaque",
      output_format: args.output_format,
      moderation: args.moderation,
      output_compression: args.output_compression,
      n: 1,
      output_dir: outputDir,
      filename_prefix: `${args.filename_prefix}-background`,
      image_paths: [sourceProxy.path],
      input_preprocessing: false,
      max_input_bytes: args.max_input_bytes,
      max_single_input_bytes: args.max_single_input_bytes,
      max_input_long_edge: args.max_input_long_edge,
      input_compression_quality: args.input_compression_quality,
      preserve_alpha: args.preserve_alpha,
      extra: args.extra
    };

    const result = await editImages(backgroundArgs, signal);
    background = {
      prompt: backgroundArgs.prompt,
      images: result.images
    };
  }

  return {
    mode: "element_extraction",
    source_image: expandHome(args.image_path),
    source_proxy: inputReportForResult([sourceProxy]),
    output_dir: outputDir,
    extraction_note: "This tool intentionally isolates or reconstructs named elements from a flattened source image as opaque images. It does not recover original PSD/Figma layers or use external background-removal helpers.",
    elements: extracted,
    background
  };
}

async function editImages(args, signal) {
  assertConfigured();
  const outputDir = ensureOutputDir(args.output_dir);
  const endpoint = `${baseUrl}/images/edits`;
  const form = new FormData();
  const request = buildJsonRequest(args);
  const preparedInputs = await prepareInputImages(args);

  for (const [key, value] of Object.entries(request)) {
    if (key === "extra" || value === undefined || value === null) continue;
    if (typeof value === "object") {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }

  for (const input of preparedInputs) {
    form.append("image[]", await fileBlob(input.path), path.basename(input.path));
  }
  if (args.mask_path) {
    const mask = await prepareInputImage(args.mask_path, { ...args, preserve_alpha: true });
    form.append("mask", await fileBlob(mask.path), path.basename(mask.path));
  }

  return requestImages({
    operation: "edit",
    args,
    request,
    endpoint,
    headers: authHeaders(),
    body: form,
    signal,
    outputDir,
    inputContext: inputReportForResult(preparedInputs)
  });
}

async function requestImages({ operation, args, request, endpoint, headers, body, signal, outputDir, inputContext, onPartial }) {
  const streamRequested = Boolean(request.stream);
  const partialImagesRequested = streamRequested ? request.partial_images || 0 : 0;
  const apiResult = await requestApiResponse({
    endpoint,
    headers: {
      ...headers,
      accept: streamRequested ? "text/event-stream" : "application/json"
    },
    body,
    signal,
    timeoutMs: requestTimeoutMs
  });
  try {
    const consumed = await consumeImageApiResponse(apiResult.response, transportOptions({
      outputDir,
      prefix: args.filename_prefix,
      outputFormat: args.output_format,
      signal,
      requestId: apiResult.request_id,
      upstreamRequestId: apiResult.upstream_request_id,
      clientRequestId: apiResult.client_request_id,
      lifecycle: apiResult.lifecycle,
      endpoint,
      operation,
      secret: apiKey,
      onPartial
    }));
    return {
      mode: operation,
      endpoint,
      model: request.model,
      stream: streamRequested,
      stream_requested: streamRequested,
      response_mode: consumed.response_mode,
      partial_images_requested: partialImagesRequested,
      ...(inputContext ? { input_context: inputContext } : {}),
      ...consumed
    };
  } finally {
    apiResult.lifecycle.cleanup();
  }
}

function buildJsonRequest(args) {
  if (Object.hasOwn(args.extra || {}, "stream") || Object.hasOwn(args.extra || {}, "partial_images")) {
    throw invalidArgument("extra.stream and extra.partial_images are reserved. Use the top-level fields instead.");
  }
  const request = {
    model: args.model || defaultModel,
    prompt: args.prompt,
    size: args.size || "auto",
    quality: args.quality || "auto",
    background: args.background || "auto",
    output_format: args.output_format || "png",
    moderation: args.moderation || "auto",
    n: args.n || 1
  };

  if (Number.isInteger(args.output_compression)) {
    request.output_compression = args.output_compression;
  }
  if (args.stream) {
    request.stream = true;
    request.partial_images = args.partial_images || 0;
  }

  const merged = {
    ...request,
    ...(args.extra || {})
  };
  validateImageArgs({
    ...merged,
    stream: Boolean(args.stream),
    partial_images: args.partial_images ?? 0
  });
  return merged;
}

function normalizeElementSpec(element) {
  if (typeof element === "string") {
    return {
      name: element,
      description: "",
      prompt: ""
    };
  }
  return {
    name: element.name,
    description: element.description || "",
    prompt: element.prompt || ""
  };
}

function buildElementExtractionPrompt(element, promptPrefix) {
  const parts = [
    "Use the source design image as visual reference.",
    `Isolate only this subject/design element as a standalone asset: ${element.name}.`,
    element.description ? `Element identification: ${element.description}.` : "",
    element.prompt ? `Element-specific instruction: ${element.prompt}.` : "",
    promptPrefix ? `Shared instruction: ${promptPrefix}.` : "",
    "Output an opaque PNG/WebP image for this extraction workflow.",
    "Focus on the requested subject. Reduce surrounding scene, UI, background, unrelated objects, labels, captions, shadows that belong to the background, and cropped neighboring elements where possible, but do not claim to create a true transparent cutout.",
    "Preserve the subject's visible style, colors, lighting, texture, proportions, silhouette, soft edges, glow, and fine details from the source image.",
    "Center the subject with a small safe margin. Do not crop the subject. Do not add a frame, canvas, sticker border, drop shadow, or new decorative elements.",
    "Do not add new text. If the element itself contains text, keep it only when it is visibly part of that element."
  ];
  return parts.filter(Boolean).join(" ");
}

function buildBackgroundExtractionPrompt(promptPrefix) {
  const parts = [
    "Use the source design image as visual reference.",
    "Recreate only the clean underlying background/backdrop as a standalone asset.",
    promptPrefix ? `Shared instruction: ${promptPrefix}.` : "",
    "Remove foreground characters, products, UI panels, icons, text, labels, and decorative elements that are not part of the background.",
    "Fill any removed areas naturally so the result works as a reusable background plate."
  ];
  return parts.filter(Boolean).join(" ");
}

function slugifyFilename(value) {
  const slug = String(value || "element")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "element";
}

function validateImageArgs(args) {
  if (args.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(args.size || "");
    if (!match) throw invalidArgument(`Invalid size '${args.size}'. Use auto or WIDTHxHEIGHT.`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    const pixels = width * height;
    if (longEdge > 3840 || width % 16 !== 0 || height % 16 !== 0 || longEdge / shortEdge > 3 || pixels < 655360 || pixels > 8294400) {
      throw invalidArgument(`Invalid size '${args.size}'. Edges must be multiples of 16, max 3840px, ratio at most 3:1, and total pixels 655360-8294400.`);
    }
  }
  if (!IMAGE2_QUALITIES.has(args.quality)) {
    throw invalidArgument(`Invalid quality '${args.quality}'.`);
  }
  if (!BACKGROUNDS.has(args.background)) {
    throw invalidArgument(`Invalid background '${args.background}'.`);
  }
  if (!OUTPUT_FORMATS.has(args.output_format)) {
    throw invalidArgument(`Invalid output_format '${args.output_format}'.`);
  }
  if (!MODERATIONS.has(args.moderation)) {
    throw invalidArgument(`Invalid moderation '${args.moderation}'.`);
  }
  if (!Number.isInteger(args.n) || args.n < 1 || args.n > 10) {
    throw invalidArgument("n must be an integer between 1 and 10.");
  }
  if (typeof args.stream !== "undefined" && typeof args.stream !== "boolean") {
    throw invalidArgument("stream must be a boolean.");
  }
  const partialImages = args.partial_images ?? 0;
  if (!Number.isInteger(partialImages) || partialImages < 0 || partialImages > MAX_PARTIAL_IMAGES) {
    throw invalidArgument("partial_images must be an integer between 0 and 3.");
  }
  if (partialImages > 0 && !args.stream) {
    throw invalidArgument("partial_images greater than 0 requires stream=true.");
  }
  if (args.background === "transparent" && !new Set(["png", "webp"]).has(args.output_format)) {
    throw invalidArgument("background=transparent requires output_format png or webp.");
  }
}

function invalidArgument(message) {
  return new Image2Error(message, { code: "INVALID_ARGUMENT", stage: "validation" });
}

async function prepareInputImages(args) {
  const paths = resolveInputImagePaths(args);
  if (!paths.length) {
    throw new Error("image2_edit requires at least one image path or image_asset_id.");
  }

  const unique = [];
  const seen = new Set();
  for (const imagePath of paths) {
    const resolved = expandHome(imagePath);
    const hash = hashFile(resolved);
    if (seen.has(hash)) continue;
    seen.add(hash);
    unique.push(resolved);
  }

  const prepared = [];
  for (const imagePath of unique) {
    prepared.push(await prepareInputImage(imagePath, args));
  }

  enforceInputBudget(prepared, args.max_input_bytes || DEFAULT_MAX_INPUT_BYTES);
  return prepared;
}

function resolveInputImagePaths(args) {
  const paths = [];
  for (const imagePath of args.image_paths || []) {
    paths.push(imagePath);
  }
  for (const assetId of args.image_asset_ids || []) {
    const asset = registeredAssets.assets?.[assetId];
    if (!asset) throw new Error(`Unknown image_asset_id: ${assetId}`);
    paths.push(asset.path);
  }
  return paths;
}

async function prepareInputImage(imagePath, args = {}) {
  const resolved = expandHome(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input image does not exist: ${resolved}`);
  }

  const original = imageMetadata(resolved);
  const inputPreprocessing = args.input_preprocessing !== false;
  const maxLongEdge = args.max_input_long_edge || DEFAULT_MAX_INPUT_LONG_EDGE;
  const quality = args.input_compression_quality || DEFAULT_INPUT_COMPRESSION_QUALITY;
  const maxSingleBytes = args.max_single_input_bytes || DEFAULT_MAX_SINGLE_INPUT_BYTES;
  const hasAlpha = Boolean(original.hasAlpha);
  const shouldResize = original.longEdge > maxLongEdge;
  const needsFormatConversion = original.ext === ".tiff" || original.ext === ".tif";
  const shouldCompress = original.bytes > maxSingleBytes || needsFormatConversion;

  if (!inputPreprocessing || process.platform !== "darwin" || (!shouldResize && !shouldCompress)) {
    return {
      path: resolved,
      original_path: resolved,
      original_bytes: original.bytes,
      bytes: original.bytes,
      width: original.width,
      height: original.height,
      format: original.ext.replace(/^\./, "") || "unknown",
      prepared: false
    };
  }

  const sourceHash = hashFile(resolved).slice(0, 16);
  const keepAlpha = hasAlpha && args.preserve_alpha !== false;
  const targetFormat = keepAlpha ? "png" : "jpeg";
  const outputPath = path.join(
    INPUT_CACHE_DIR,
    `${path.basename(resolved, path.extname(resolved)).replace(/[^a-zA-Z0-9._-]/g, "_")}-${sourceHash}-${maxLongEdge}-${quality}.${targetFormat === "jpeg" ? "jpg" : "png"}`
  );

  if (!fs.existsSync(outputPath)) {
    const command = targetFormat === "jpeg"
      ? ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(maxLongEdge), resolved, "--out", outputPath]
      : ["-s", "format", "png", "-Z", String(maxLongEdge), resolved, "--out", outputPath];
    try {
      execFileSync("sips", command, { stdio: "ignore" });
    } catch {
      return {
        path: resolved,
        original_path: resolved,
        original_bytes: original.bytes,
        bytes: original.bytes,
        width: original.width,
        height: original.height,
        format: original.ext.replace(/^\./, "") || "unknown",
        prepared: false
      };
    }
  }

  const prepared = imageMetadata(outputPath);
  const usePrepared = prepared.bytes < original.bytes || original.bytes > maxSingleBytes || shouldResize;
  const finalPath = usePrepared ? outputPath : resolved;
  const finalMeta = usePrepared ? prepared : original;

  return {
    path: finalPath,
    original_path: resolved,
    original_bytes: original.bytes,
    bytes: finalMeta.bytes,
    width: finalMeta.width,
    height: finalMeta.height,
    format: finalMeta.ext.replace(/^\./, "") || targetFormat,
    prepared: usePrepared
  };
}

function enforceInputBudget(inputs, maxInputBytes) {
  const total = inputs.reduce((sum, input) => sum + input.bytes, 0);
  if (total <= maxInputBytes) return;
  const mb = (value) => `${(value / 1024 / 1024).toFixed(2)}MB`;
  const lines = inputs.map((input) => `${path.basename(input.original_path)}: ${mb(input.original_bytes)} -> ${mb(input.bytes)}`);
  throw new Error(`Prepared Image2 input images are ${mb(total)}, over max_input_bytes ${mb(maxInputBytes)}. Lower max_input_long_edge, reduce reference image count, or register only the current target image. ${lines.join("; ")}`);
}

function inputReportForResult(inputs) {
  const totalOriginalBytes = inputs.reduce((sum, input) => sum + input.original_bytes, 0);
  const totalPreparedBytes = inputs.reduce((sum, input) => sum + input.bytes, 0);
  return {
    image_count: inputs.length,
    original_bytes: totalOriginalBytes,
    prepared_bytes: totalPreparedBytes,
    saved_bytes: Math.max(0, totalOriginalBytes - totalPreparedBytes),
    max_long_edge: Math.max(0, ...inputs.map((input) => Math.max(input.width || 0, input.height || 0))),
    prepared_images: inputs.map((input) => ({
      filename: path.basename(input.path),
      original_filename: path.basename(input.original_path),
      bytes: input.bytes,
      original_bytes: input.original_bytes,
      width: input.width,
      height: input.height,
      format: input.format,
      prepared: input.prepared
    }))
  };
}

async function fileBlob(filePath) {
  const resolved = expandHome(filePath);
  const bytes = fs.readFileSync(resolved);
  return new Blob([bytes], { type: mimeTypeForPath(resolved) });
}

function registerImageAsset(args) {
  const resolved = expandHome(args.image_path);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input image does not exist: ${resolved}`);
  }
  const meta = imageMetadata(resolved);
  const hash = hashFile(resolved);
  const assetId = `img_${hash.slice(0, 12)}`;
  const now = new Date().toISOString();
  const existing = registeredAssets.assets?.[assetId];
  registeredAssets.assets ||= {};
  registeredAssets.assets[assetId] = {
    id: assetId,
    path: resolved,
    name: args.name || existing?.name || path.basename(resolved),
    description: args.description || existing?.description || "",
    tags: args.tags || existing?.tags || [],
    hash,
    bytes: meta.bytes,
    width: meta.width,
    height: meta.height,
    has_alpha: meta.hasAlpha,
    created_at: existing?.created_at || now,
    updated_at: now
  };
  saveAssetRegistry();
  return {
    asset: publicAsset(registeredAssets.assets[assetId]),
    usage: {
      edit_with_asset: {
        image_asset_ids: [assetId]
      }
    }
  };
}

function publicAsset(asset) {
  return {
    id: asset.id,
    path: asset.path,
    name: asset.name,
    description: asset.description,
    tags: asset.tags,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    has_alpha: asset.has_alpha,
    updated_at: asset.updated_at
  };
}

function imageMetadata(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const output = runSips(["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", filePath]);
  const width = numberFromSips(output, "pixelWidth") || 0;
  const height = numberFromSips(output, "pixelHeight") || 0;
  const hasAlpha = /hasAlpha:\s*yes/i.test(output);
  return {
    ext,
    bytes: stat.size,
    width,
    height,
    longEdge: Math.max(width, height),
    hasAlpha
  };
}

function runSips(args) {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("sips", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function numberFromSips(output, key) {
  const match = output.match(new RegExp(`${key}:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function authHeaders() {
  return { authorization: `Bearer ${apiKey}` };
}

function assertConfigured() {
  if (!apiKey) {
    throw new Image2Error("IMAGE2_API_KEY is not configured. Set it in ~/.codex/image2-mcp.env.", {
      code: "CONFIG_ERROR",
      stage: "configuration"
    });
  }
}

function normalizeBaseUrl(url) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function ensureOutputDir(outputDir) {
  const resolved = expandHome(outputDir || defaultOutputDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function transportOptions({ outputDir, prefix, outputFormat, signal, requestId, upstreamRequestId, clientRequestId, lifecycle, endpoint, operation, secret, onPartial }) {
  return {
    outputDir,
    prefix,
    outputFormat,
    signal,
    requestId,
    upstreamRequestId,
    clientRequestId,
    lifecycle,
    endpoint,
    operation,
    secret,
    onPartial,
    baseUrl,
    downloadTimeoutMs,
    maxOutputBytes
  };
}

function loadAssetRegistry() {
  if (!fs.existsSync(ASSETS_FILE)) return { version: 1, assets: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(ASSETS_FILE, "utf8"));
    return {
      version: 1,
      assets: parsed.assets && typeof parsed.assets === "object" ? parsed.assets : {}
    };
  } catch {
    return { version: 1, assets: {} };
  }
}

function saveAssetRegistry() {
  fs.writeFileSync(ASSETS_FILE, JSON.stringify(registeredAssets, null, 2));
}

function updateJob(jobId, patch) {
  const record = jobs.get(jobId);
  if (!record) return;
  Object.assign(record, patch, { updated_at: new Date().toISOString() });
  writeJob(record);
}

function writeJob(record) {
  const file = path.join(JOBS_DIR, `${record.job_id}.json`);
  fs.writeFileSync(file, JSON.stringify(publicJob(record), null, 2));
}

function readJob(jobId) {
  const file = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function publicJob(record) {
  if (!record) return null;
  const { controller, ...publicRecord } = record;
  return publicRecord;
}

function sanitizeForRecord(args) {
  const copy = { ...args };
  if (copy.extra && typeof copy.extra === "object") {
    copy.extra = { ...copy.extra };
    for (const key of Object.keys(copy.extra)) {
      if (/api[-_]?key|authorization|bearer|token|secret|password/i.test(key)) {
        copy.extra[key] = "<redacted>";
      }
    }
  }
  return copy;
}

function withToolErrors(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return jsonToolResult(toolErrorPayload(error), true);
    }
  };
}

function jsonToolResult(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
