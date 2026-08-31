// pi-zai-tools-gate: only expose zai_* tools when the active model's provider is in the
// allow-list (default: ["zai", "zai-1m"]). When switching to GPT/Claude/etc., all zai_*
// tools are deactivated so the model uses its own native capabilities instead.
//
// Additionally, when the active model has native image input (e.g. GLM-5.3-Flash),
// zai_vision_* tools are deactivated so native multimodal input is used instead —
// except tools in visionKeep (default: none — a visible video tool caused
// tool-confusion loops: GLM-5.3-Flash grabbed zai_vision_analyze_video for
// image OCR tasks and burned turns on junk calls). Web search / reader / zread tools are
// never affected by vision gating.
//
// Config in ~/.pi/agent/settings.json (or .pi/settings.json):
//   "zaiGate": {
//     "allowProviders": ["zai", "zai-1m"],   // providers that may use zai tools
//     "toolPrefix": "zai_",                 // tools with this name prefix are gated
//     "alwaysAllow": ["zai_web_reader"],    // optional: keep these regardless
//     "allowForImageInput": false,           // optional: also allow when model has no image input
//     "visionToolPrefix": "zai_vision",      // prefix gated off for native-image models
//     "visionKeep": [],                            // vision tools kept for native-image models
//     "gateVisionWhenNativeImage": true      // disable vision gating if false
//   }
//
// All keys optional. Defaults shown above.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ZaiGateConfig {
  allowProviders?: string[];
  toolPrefix?: string;
  alwaysAllow?: string[];
  allowForImageInput?: boolean;
  visionToolPrefix?: string;
  visionKeep?: string[];
  gateVisionWhenNativeImage?: boolean;
}

const DEFAULTS: Required<ZaiGateConfig> = {
  allowProviders: ["zai", "zai-1m"],
  toolPrefix: "zai_",
  alwaysAllow: [],
  allowForImageInput: false,
  visionToolPrefix: "zai_vision",
  visionKeep: [],
  gateVisionWhenNativeImage: true,
};

function loadConfig(): Required<ZaiGateConfig> {
  const candidates = [
    join(process.cwd(), ".pi", "settings.json"),
    join(homedir(), ".pi", "agent", "settings.json"),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      const user = (parsed?.zaiGate ?? {}) as ZaiGateConfig;
      return { ...DEFAULTS, ...user };
    } catch {
      // try next
    }
  }
  return { ...DEFAULTS };
}

function gateAllowed(
  provider: string | undefined,
  hasImageInput: boolean,
  cfg: Required<ZaiGateConfig>,
): boolean {
  if (provider && cfg.allowProviders.includes(provider)) return true;
  if (cfg.allowForImageInput && !hasImageInput) return true;
  return false;
}

function applyGate(pi: ExtensionAPI, provider: string | undefined, hasImageInput: boolean) {
  const cfg = loadConfig();
  const allowed = gateAllowed(provider, hasImageInput, cfg);

  const current = pi.getActiveTools();
  const isGated = (name: string) =>
    name.startsWith(cfg.toolPrefix) && !cfg.alwaysAllow.includes(name);

  let next: string[];
  if (allowed) {
    // Re-activate any zai_* tools that were previously gated off.
    // We cannot resurrect tools that were never registered, so just ensure
    // currently-registered gated tools are active.
    const all = pi.getAllTools().map((t) => t.name);
    const missing = all.filter((name) => isGated(name) && !current.includes(name));
    next = [...current, ...missing];

    // Native-image vision gating: the model sees images itself, so remote
    // vision tools would shadow native multimodal input. Video stays (pi
    // cannot attach video directly); alwaysAllow always wins.
    if (cfg.gateVisionWhenNativeImage && hasImageInput) {
      next = next.filter(
        (name) =>
          !name.startsWith(cfg.visionToolPrefix) ||
          cfg.visionKeep.includes(name) ||
          cfg.alwaysAllow.includes(name),
      );
    }
  } else {
    next = current.filter((name) => !isGated(name));
  }

  // Avoid spurious updates.
  const sameLength = next.length === current.length;
  const unchanged = sameLength && next.every((n, i) => n === current[i]);
  if (unchanged) return;

  pi.setActiveTools(next);
}

export default function zaiGateExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const provider = ctx.model?.provider;
    const hasImageInput = (ctx.model?.input ?? []).includes("image");
    applyGate(pi, provider, hasImageInput);
  });

  pi.on("model_select", async (event) => {
    const provider = event.model?.provider;
    const hasImageInput = (event.model?.input ?? []).includes("image");
    applyGate(pi, provider, hasImageInput);
  });
}
