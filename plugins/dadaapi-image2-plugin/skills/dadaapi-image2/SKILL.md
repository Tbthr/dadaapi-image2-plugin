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
- Register reused local images with `image2_register_asset` and pass `image_asset_ids` to later edits.
- Send only the current task, target image or asset, optional mask, and up to three explicit references. Do not resend historical images or full conversation state.

## Respect limits

- Do not request transparency, alpha output, transparent PNGs, true cutouts, or transparent background removal. Explain that GPT Image2 returns opaque images.
- Keep image operations in this plugin unless the user explicitly requests another tool.
- If the API key is missing, ask the user to configure `~/.codex/image2-mcp.env` instead of requesting a key in chat.

## Return results

- Parse every tool result for final and partial image paths, including `images[].path`, `partial_images[].path`, `elements[].images[].path`, and `background.images[].path`.
- Before returning a path, verify that the local file exists, is non-empty, and is a PNG, JPEG, or WebP image. Never fabricate or infer an output path.
- Render each final local image inline with its absolute path: `![Preview](/absolute/path/to/image.png)`.
- If the error code is `INCOMPLETE_STREAM`, render any `partial_images` only as incomplete previews and say that no final image was produced.
- Do not show visible file paths or save locations unless the user asks for them.
- Keep progress updates short.

## Handle failures

- Do not automatically repeat a generation after `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `EMPTY_IMAGE_RESULT`, `INVALID_IMAGE_DATA`, or `INCOMPLETE_STREAM`. The provider may already have accepted the request, so repeating it can consume quota twice.
- The plugin retries a transient download failure once against the same result URL. If `IMAGE_DOWNLOAD_ERROR` remains, report it rather than starting a new generation.
- For `CONFIG_ERROR`, ask the user to configure `~/.codex/image2-mcp.env` and run `image2_doctor`; never request the API key in chat.
- For `API_HTTP_ERROR`, report the HTTP status, request id when present, and the provider message. Do not retry 401, 403, or 404 responses.
- For other structured errors, report `error.code` and `error.message` briefly and suggest `image2_doctor` when configuration or connectivity may be involved.
