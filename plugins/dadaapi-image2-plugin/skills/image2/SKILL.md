---
name: image2
description: Generate, edit, extract, or preview images with 哒哒API Image2. Use when a user requests image generation, image-to-image editing, element extraction from a design, asynchronous image generation, or inline previews of generated image files.
---

# 哒哒API Image2

## Choose tools

- Use `image2_generate` for a simple generation request.
- Use `image2_edit` to transform a supplied image while retaining the composition.
- Use `image2_extract_elements` to recreate named subjects or design elements as opaque PNG or WebP files.
- Use `image2_start_generation` for slow or multi-image work, then poll with `image2_get_job`; use `image2_cancel_job` only to stop a running job.
- Register reused local images with `image2_register_asset` and pass `image_asset_ids` to later edits.
- Send only the current task, target image or asset, optional mask, and up to three explicit references. Do not resend historical images or full conversation state.

## Respect limits

- Do not request transparency, alpha output, transparent PNGs, true cutouts, or transparent background removal. Explain that GPT Image2 returns opaque images.
- Keep image operations in this plugin unless the user explicitly requests another tool.
- If the API key is missing, ask the user to configure `~/.codex/image2-mcp.env` instead of requesting a key in chat.

## Return results

- Parse every tool result for final and partial image paths, including `images[].path`, `partial_images[].path`, `elements[].images[].path`, and `background.images[].path`.
- Render each final local image inline with its absolute path: `![Preview](/absolute/path/to/image.png)`.
- Do not show visible file paths or save locations unless the user asks for them.
- Keep progress updates short. Retry an unchanged failed generation once; if it fails again, report the concrete error briefly.
