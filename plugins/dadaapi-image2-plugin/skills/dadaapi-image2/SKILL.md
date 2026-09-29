---
name: dadaapi-image2
description: Generate, edit, extract, or preview images with DadaAPI Image2. Use when a user requests image generation, image-to-image editing, element extraction from a design, asynchronous image generation, or inline previews of generated image files.
---

# DadaAPI Image2

## Choose tools

- Use `image2_generate` for a simple generation request.
- Use `image2_edit` to transform a supplied image while retaining the composition.
- Use `image2_extract_elements` to recreate named subjects or design elements as opaque PNG or WebP files.
- Use `image2_doctor` to diagnose configuration, output directory, API connectivity, or model access without consuming image-generation quota.
- Use `image2_start_generation` for slow or multi-image work, then poll with `image2_get_job`; use `image2_cancel_job` only to stop a running job.
- For interactive partial previews, call `image2_start_generation` with `stream: true` and `partial_images: 1..3`; `image2_get_job` can expose saved partials while the job is still running. Synchronous tools return only after the final image arrives.
- Register reused local images with `image2_register_asset` and pass `image_asset_ids` to later edits.
- Send only the current task, target image or asset, optional mask, and up to three explicit references. Do not resend historical images or full conversation state.

## Respect limits

- If the user asks which model to choose, recommend `gpt-image-2.5-flare` for fast everyday generation and `gpt-image-2.5-sunburst` when demanding quality or precise editing matters most. Use `gpt-image-2` when the user's API key or channel does not expose GPT Image 2.5.
- The persistent default is `IMAGE2_MODEL` in `~/.codex/image2-mcp.env`; a model passed to one tool call applies to that request. Run `image2_doctor` after changing the configured model to check visibility.
- GPT Image 2.5 Flare and Sunburst support transparent PNG/WebP output. `gpt-image-2` supports transparent output in preview. Provider-compatible channels may reject these features; report that API error without switching models.
- The API supports `xhigh` and `max` quality for GPT Image 2.5, but this plugin currently exposes only `auto`, `low`, `medium`, and `high`.
- `image2_extract_elements` intentionally produces opaque reconstructions rather than guaranteed transparent cutouts.
- This plugin accepts only OpenAI Images API JSON and bounded Images SSE lifecycle events (`queued`, `in_progress`, `partial_image`, `completed`). Do not treat `/v1/responses` image tool events as compatible output.
- Partial images add image output tokens. Keep `stream: false` and `partial_images: 0` when only the final image is needed.
- Keep image operations in this plugin unless the user explicitly requests another tool.
- If the API key is missing, ask the user to configure `~/.codex/image2-mcp.env` instead of requesting a key in chat.

## Return results

- Parse every tool result for final and partial image paths, including `images[].path`, `partial_images[].path`, `elements[].images[].path`, and `background.images[].path`.
- Before returning a path, verify that the local file exists, is non-empty, and is a PNG, JPEG, or WebP image. Never fabricate or infer an output path.
- Render each final local image inline with its absolute path: `![Preview](/absolute/path/to/image.png)`.
- If the error code is `INCOMPLETE_STREAM`, render any `partial_images` only as incomplete previews and say that no final image was produced.
- If the error code is `UPSTREAM_PROTOCOL_ERROR`, report the request id and safe event diagnostics; do not attempt to parse Responses API events.
- When both are present, use `request_id` to trace the NewAPI gateway request and `upstream_request_id` to trace the provider request.
- Do not show visible file paths or save locations unless the user asks for them.
- Keep progress updates short.

## Handle failures

- Do not automatically repeat a generation after `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `EMPTY_IMAGE_RESULT`, `INVALID_IMAGE_DATA`, or `INCOMPLETE_STREAM`. The provider may already have accepted the request, so repeating it can consume quota twice.
- The plugin retries a transient download failure once against the same result URL. If `IMAGE_DOWNLOAD_ERROR` remains, report it rather than starting a new generation.
- For `CONFIG_ERROR`, ask the user to configure `~/.codex/image2-mcp.env` and run `image2_doctor`; never request the API key in chat.
- For `API_HTTP_ERROR`, report the HTTP status, request id when present, and the provider message. Do not retry 401, 403, or 404 responses.
- For other structured errors, report `error.code` and `error.message` briefly and suggest `image2_doctor` when configuration or connectivity may be involved.
