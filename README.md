# pi-zai-tools-gate

Pi extension that gates `zai_*` tools to specific model providers.

## The problem

If you use [pi-zai-tools](https://github.com/ulusoyomer/pi-zai-tools) alongside non-zai models (GPT, Claude, Gemini, etc.), the zai tools stay active for every model. The LLM then sees `zai_vision_*`, `zai_web_search`, etc. in its tool list and calls them instead of using its own native capabilities.

The most visible case: you attach an image while running a GPT model, and instead of using GPT vision it routes through `zai_vision_analyze_image` (Z.AI's GLM vision) — slower, billed separately, and not what you wanted.

The mirror image arrived with GLM-5.3-Flash: a `zai`-provider model with **native image input**. If `zai_vision_*` tools stay active there, they shadow the model's own multimodal input the same way.

Manually toggling tools every time you `/model` switch gets old fast.

## What it does

On `session_start` and every `model_select` (i.e. `/model`, model cycling, session restore), this extension:

- Checks the active model's `provider`.
- If the provider is in `allowProviders` (default: `["zai", "zai-1m"]`) → all `zai_*` tools stay active.
- If the provider is **not** allowed → every `zai_*` tool (except those in `alwaysAllow`) is deactivated via `setActiveTools`. The model falls back to its own native tools.
- **Native-image vision gating**: when the provider is allowed **and** the model accepts image input (e.g. GLM-5.3-Flash via [pi-zai-models](https://github.com/keen99/pi-zai-models)), `zai_vision_*` tools are deactivated so the model uses its native multimodal input instead. Tools in `visionKeep` (default: `zai_vision_analyze_video`, because pi cannot attach video to a model directly) and `alwaysAllow` stay. Web search / web reader / zread tools are **never** affected by vision gating — no pi model has native web search, so those tools remain the only search path.
- Switching back reactivates the gated-off tools automatically.

No manual toggling. Switch models freely; zai tools follow the active provider and modality.

## Install

```bash
pi install git:github.com/keen99/pi-zai-tools-gate
```

Or from a local checkout:

```bash
pi install /absolute/path/to/pi-zai-tools-gate
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- Not required, but pointless without: [pi-zai-tools](https://github.com/ulusoyomer/pi-zai-tools) (or any other package that registers tools named with the `zai_` prefix).

## Configuration

All config is optional and lives in `settings.json` (global: `~/.pi/agent/settings.json`, or project: `.pi/settings.json`) under the `zaiGate` key:

```json
{
  "zaiGate": {
    "allowProviders": ["zai", "zai-1m"],
    "toolPrefix": "zai_",
    "alwaysAllow": ["zai_web_reader", "zai_zread_search_doc"],
    "allowForImageInput": false,
    "visionToolPrefix": "zai_vision",
    "visionKeep": ["zai_vision_analyze_video"],
    "gateVisionWhenNativeImage": true
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allowProviders` | `string[]` | `["zai", "zai-1m"]` | Providers that are allowed to use zai tools. Any model whose `provider` is in this list keeps all `zai_*` tools active. `zai-1m` is the full-context provider registered by [pi-zai-models](https://github.com/keen99/pi-zai-models). |
| `toolPrefix` | `string` | `"zai_"` | Tools whose name starts with this prefix are gated. Change if you vendor/rename the tools. |
| `alwaysAllow` | `string[]` | `[]` | Tool names to keep active for **every** model, regardless of provider or modality. Use this for tools with no good native equivalent (e.g. `zai_web_reader`, `zai_zread_*`). |
| `allowForImageInput` | `boolean` | `false` | If `true`, also allow zai tools for models that have **no** image input capability (i.e. text-only models). Useful if you only care about preventing zai from shadowing native vision and want zai to fill the gap for text-only models. |
| `visionToolPrefix` | `string` | `"zai_vision"` | Prefix gated off for models with native image input. |
| `visionKeep` | `string[]` | `["zai_vision_analyze_video"]` | Vision-prefix tools kept active even for native-image models (pi cannot attach video directly, so the remote video tool stays useful). |
| `gateVisionWhenNativeImage` | `boolean` | `true` | Master switch for native-image vision gating. `false` disables it; vision tools then stay active for allowed providers regardless of modality. |

### Defaults

With no config block at all, the extension gates **all** `zai_*` tools off for every provider except `zai`. This is the intended default: GLM models use the Z.AI tooling they were designed for; everything else uses its own native vision/search/etc.

### Examples

**GPT vision only, keep web reader + zread for all models:**

```json
{
  "zaiGate": {
    "allowProviders": ["zai", "zai-1m"],
    "alwaysAllow": ["zai_web_reader", "zai_zread_search_doc", "zai_zread_get_repo_structure", "zai_zread_read_file"]
  }
}
```

**Disable vision gating entirely (zai_vision_* stays for all allowed models):**

```json
{
  "zaiGate": {
    "gateVisionWhenNativeImage": false
  }
}
```

**Use zai tools for GLM and any text-only model (only block multimodal non-zai models):**

```json
{
  "zaiGate": {
    "allowProviders": ["zai", "zai-1m"],
    "allowForImageInput": true
  }
}
```

**Also expose zai tools to a second provider (e.g. a local proxy provider named `glm-proxy`):**

```json
{
  "zaiGate": {
    "allowProviders": ["zai", "zai-1m", "glm-proxy"]
  }
}
```

**Gate a different family of tools (e.g. `foo_*`):**

```json
{
  "zaiGate": {
    "toolPrefix": "foo_",
    "allowProviders": ["foo-provider"]
  }
}
```

## How it works

The extension listens to two pi events:

- `session_start` — applies the gate at startup / new session / session resume.
- `model_select` — fires on `/model`, `Ctrl+P` cycling, and session restore. Re-applies the gate whenever the active model changes.

On each event it reads the current model's `provider` and `input` (whether it accepts `image`), compares against the config, then calls `pi.setActiveTools(...)` with the adjusted list:

- Not an allowed provider → gated-prefix tools removed.
- Allowed provider, no image input → gated-prefix tools ensured active.
- Allowed provider, image input → gated-prefix tools ensured active, then vision-prefix tools removed (minus `visionKeep` / `alwaysAllow`).

When reactivating tools after switching back to an allowed provider, it re-enables any currently-registered gated tools that were previously turned off.

Config is re-read from `settings.json` on every event, so changes take effect on the next model switch or session reload — no restart needed for config edits.

## Limitations

- The extension can only re-activate tools that are **currently registered**. If `pi-zai-tools` failed to load (missing `ZAI_API_KEY`, module error, etc.), switching to an allowed provider cannot bring them back. Fix the underlying load issue, then switch models to re-trigger the gate.
- `setActiveTools` replaces the active set. The extension is careful to preserve the rest of your tool list (it only adds/removes the gated names), but if another extension also manages the active tool set at the same moment, they may race. In practice this is not an issue because the gate runs on discrete model-switch events.
- Provider matching is by exact `provider` string. If you rename providers via custom config, update `allowProviders` to match.

## License

MIT
