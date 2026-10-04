import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const mod = await import("../index.js");
const { gateAllowed, applyGate, loadConfig, DEFAULTS, default: zaiGate } = mod as any;

// ── harness ─────────────────────────────────────────────────────────────
function fakePi(active: string[], all: Array<{ name: string }>) {
	const calls: string[][] = [];
	const pi: any = {
		getActiveTools: () => [...active],
		getAllTools: () => all.map((n) => ({ name: n.name })),
		setActiveTools: (next: string[]) => { calls.push(next); active = next; },
	};
	return { pi, calls };
}

const TOOLS = ["zai_web_search", "zai_web_reader", "zai_vision_analyze_image", "zai_vision_analyze_video", "read", "bash"];
const ALL = TOOLS.map((name) => ({ name }));

// ── gateAllowed ─────────────────────────────────────────────────────────
test("gateAllowed: allowProviders membership", () => {
	assert.equal(gateAllowed("zai", false, DEFAULTS), true);
	assert.equal(gateAllowed("zai-1m", true, DEFAULTS), true);
	assert.equal(gateAllowed("openai", false, DEFAULTS), false);
	assert.equal(gateAllowed(undefined, false, DEFAULTS), false);
});

test("gateAllowed: allowForImageInput escape hatch", () => {
	const cfg = { ...DEFAULTS, allowForImageInput: true };
	assert.equal(gateAllowed("openai", false, cfg), true, "no native image → allowed");
	assert.equal(gateAllowed("openai", true, cfg), false, "native image → still denied");
});

// ── applyGate: denied provider strips zai_* ─────────────────────────────
test("denied provider: zai_* removed, non-zai untouched, setActiveTools called", () => {
	const { pi, calls } = fakePi([...TOOLS], ALL);
	applyGate(pi, "openai", false);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], ["read", "bash"]);
});

test("allowed provider: previously gated tools reactivated, order preserved", () => {
	const { pi, calls } = fakePi(["read", "bash"], ALL);
	applyGate(pi, "zai", false);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], ["read", "bash", "zai_web_search", "zai_web_reader", "zai_vision_analyze_image", "zai_vision_analyze_video"]);
});

test("allowed provider: already-active tools not duplicated", () => {
	const { pi, calls } = fakePi([...TOOLS], ALL);
	applyGate(pi, "zai", false); // activates all
	assert.equal(calls.length, 0, "unchanged → no spurious update");
});

test("alwaysAllow keeps gated tool even under denied provider", () => {
	const cfg = { ...DEFAULTS, alwaysAllow: ["zai_web_reader"] };
	const { pi, calls } = fakePi([...TOOLS], ALL);
	applyGate(pi, "openai", false, cfg);
	assert.deepEqual(calls[0], ["zai_web_reader", "read", "bash"]);
});

// ── vision gating ───────────────────────────────────────────────────────
test("native image model: zai_vision* gated except visionKeep; web tools stay", () => {
	const { pi, calls } = fakePi([], ALL);
	applyGate(pi, "zai", true);
	assert.deepEqual(calls[0], ["zai_web_search", "zai_web_reader", "zai_vision_analyze_video"]);
});

test("alwaysAllow protects from stripping but never resurrects inactive tools", () => {
	const cfg = { ...DEFAULTS, visionKeep: [], alwaysAllow: ["zai_vision_analyze_image"] };
	const { pi, calls } = fakePi([], ALL);
	applyGate(pi, "zai", true, cfg);
	// current empty: missing = isGated-only (alwaysAllow excluded from missing),
	// so analyze_image is never added; filter then strips the unkept video tool.
	assert.deepEqual(calls[0], ["zai_web_search", "zai_web_reader"]);
});

test("gateVisionWhenNativeImage=false disables vision gating", () => {
	const cfg = { ...DEFAULTS, gateVisionWhenNativeImage: false };
	const { pi, calls } = fakePi([], ALL);
	applyGate(pi, "zai", true, cfg);
	assert.deepEqual(calls[0], ["zai_web_search", "zai_web_reader", "zai_vision_analyze_image", "zai_vision_analyze_video"]);
});

// ── config loading ──────────────────────────────────────────────────────
test("loadConfig: project .pi/settings.json overrides defaults; malformed → defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "zai-gate-"));
	const origCwd = process.cwd();
	try {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ zaiGate: { allowProviders: ["custom"], toolPrefix: "zap_" } }));
		process.chdir(dir);
		const cfg = loadConfig();
		assert.deepEqual(cfg.allowProviders, ["custom"]);
		assert.equal(cfg.toolPrefix, "zap_");
		assert.equal(cfg.visionToolPrefix, DEFAULTS.visionToolPrefix, "unspecified keys fall back to defaults");

		writeFileSync(join(dir, ".pi", "settings.json"), "{ broken");
		assert.deepEqual(loadConfig().allowProviders, DEFAULTS.allowProviders, "malformed file → defaults");
	} finally {
		process.chdir(origCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: no settings anywhere → pure defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "zai-gate-empty-"));
	const origCwd = process.cwd();
	try {
		process.chdir(dir);
		assert.deepEqual(loadConfig(), DEFAULTS);
	} finally {
		process.chdir(origCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── hooks ───────────────────────────────────────────────────────────────
test("session_start + model_select hooks drive applyGate from model shape", async () => {
	const handlers: Record<string, any> = {};
	const pi: any = {
		on: (ev: string, fn: any) => { handlers[ev] = fn; },
		getActiveTools: () => [...TOOLS],
		getAllTools: () => ALL,
		setActiveTools: () => {},
	};
	zaiGate(pi);
	assert.ok(handlers.session_start);
	assert.ok(handlers.model_select);

	const model = { provider: "openai", input: ["text"] };
	await handlers.session_start({}, { model });
	await handlers.model_select({ model });
});

test("image-capable model via hook: vision tools gated", async () => {
	const handlers: Record<string, any> = {};
	let setCalls: string[][] = [];
	const pi: any = {
		on: (ev: string, fn: any) => { handlers[ev] = fn; },
		getActiveTools: () => [...TOOLS],
		getAllTools: () => ALL,
		setActiveTools: (next: string[]) => { setCalls.push(next); },
	};
	zaiGate(pi);
	await handlers.model_select({ model: { provider: "zai", input: ["text", "image"] } });
	assert.deepEqual(setCalls[0], ["zai_web_search", "zai_web_reader", "zai_vision_analyze_video", "read", "bash"]);
});
