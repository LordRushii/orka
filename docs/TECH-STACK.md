# V1 Technology Stack

## Repository and tooling

- **Language:** TypeScript
- **Runtime/package manager:** Bun
- **Workspace:** Bun workspaces
- **Extension build:** WXT
- **Extension UI:** React
- **Validation:** Zod
- **Testing:** Vitest for modules and Playwright for browser end-to-end flows

## Browser extension

- **Target browsers:** Chrome, Edge, and Brave first; Firefox later
- **Extension format:** Manifest V3
- **Permissions:** `activeTab`, `scripting`, `storage`, plus a static `http(s)://*/*` host grant so tasks run on the current tab with no runtime prompt
- **Capture:** `tabs.captureVisibleTab` through the active-tab permission
- **Page context:** visible/interactable accessibility and DOM snapshot from a content script
- **UI:** browser side panel with task state, approvals, audit view, provider selection, and Stop control
- **Action execution:** content-script DOM targeting with semantic evidence and live bounding-box validation
- **Explicitly excluded in V1:** Chromium debugger/CDP permission and whole-desktop capture

## Local privacy processing

- **Runtime:** ONNX Runtime Web
- **Preferred execution provider:** WebGPU when capability test and warm-up pass
- **Fallback:** WASM; WebGL only if a later benchmark justifies it
- **Text PII:** DOM semantics, deterministic regexes, and local classifiers
- **Pixel OCR:** PaddleOCR.js in a Worker, with a pinned browser-compatible model
- **Face detection:** a small local face-detection model, packaged and hash-pinned
- **Model formats:** ONNX/ORT assets with version and SHA-256 manifest
- **Modes:** Auto, GPU preferred, Balanced, CPU/WASM

## Planner gateway

- **Runtime:** Bun
- **HTTP framework:** Fastify
- **Validation:** shared Zod contracts from `packages/contracts`
- **Transport:** HTTPS for remote gateway; localhost HTTP only for a local development gateway
- **Persistence:** none for screenshots, observations, prompts, provider responses, or keys
- **Provider interface:** one provider-neutral planner adapter interface

## Planner providers

- **Cloud reference:** DeepSeek `deepseek-v4-flash-vision-exp`
- **OpenAI-compatible providers:** shared adapter for OpenAI-compatible APIs
- **Anthropic:** separate adapter for the Messages API shape
- **Local reference:** LM Studio at `http://127.0.0.1:1234/v1`
- **Local VLM reference:** Qwen3-VL-4B-Instruct or another image-capable model loaded by the user in LM Studio
- **Provider switching:** explicit user selection only; never automatic local-to-cloud fallback

## Planned package layout

```text
apps/extension
apps/gateway
packages/contracts
packages/privacy-engine
packages/provider-adapters
```

## Important constraints

- Do not place API keys in source control, model prompts, audit events, or browser page content.
- Do not load remote executable JavaScript into the extension.
- Pin model assets and verify hashes before use.
- Keep model/provider names configurable; these reference choices must not become protocol dependencies.
- Record exact package and model versions when implementation begins.
