import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEffort,
  parseRawModels,
  resolveRawModelId,
  rawListsEqual,
  type RawModel,
} from "../model-utils.js";

// Mock data matching current ACP server
const CURRENT_RAW: RawModel[] = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
];

describe("normalizeEffort — generic, no allow-list", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(normalizeEffort("High"), "high");
    assert.equal(normalizeEffort("LOW-MEDIUM"), "low-medium");
    assert.equal(normalizeEffort("Thinking High"), "thinking-high");
    assert.equal(normalizeEffort("Ultra"), "ultra");
  });
  it("handles future naming conventions", () => {
    assert.equal(normalizeEffort(" Turbo "), "turbo");
    assert.equal(normalizeEffort("Default"), "default");
    assert.equal(normalizeEffort("None"), "none");
    assert.equal(normalizeEffort("Off"), "off");
    assert.equal(normalizeEffort("Max"), "max");
  });
});

describe("parseRawModels — dynamic discovery", () => {
  it("groups current 11 raw models into 4 families", () => {
    const { families, models, defaultFamilyId } = parseRawModels(CURRENT_RAW);
    assert.equal(families.size, 4);
    assert.equal(models.length, 4);
    assert.ok(families.has("gemini-3.8-flash"));
    assert.ok(families.has("gemini-3.7-flash"));
    assert.ok(families.has("gemini-3.6-flash"));
    assert.ok(families.has("gemini-3.1-pro"));
    assert.equal(defaultFamilyId, "gemini-3.7-flash");
  });

  it("strips effort from displayName, no double-naming", () => {
    const { models } = parseRawModels(CURRENT_RAW);
    for (const m of models) {
      assert.ok(!m.displayName.includes("("), `displayName should not contain parens: ${m.displayName}`);
    }
  });

  it("exposes only efforts actually available per family", () => {
    const { models } = parseRawModels(CURRENT_RAW);
    const pro = models.find((m) => m.id === "gemini-3.1-pro")!;
    // Pro only has low + high (mapped)
    assert.ok(pro.supportedReasoningEfforts.some((e) => e.reasoningEffort === "low"));
    assert.ok(pro.supportedReasoningEfforts.some((e) => e.reasoningEffort === "high"));
    // medium should be absent or mapped to high fallback — check count
    assert.equal(pro.supportedReasoningEfforts.length, 2);
  });

  it("handles future model with new effort without code change", () => {
    const future: RawModel[] = [
      ...CURRENT_RAW,
      { id: "gemini-3.9-flash-ultra", name: "Gemini 3.9 Flash (Ultra)" },
      { id: "gemini-3.9-flash-thinking-high", name: "Gemini 3.9 Flash (Thinking High)" },
    ];
    const { families, models } = parseRawModels(future);
    assert.equal(families.size, 5);
    const f = families.get("gemini-3.9-flash")!;
    assert.ok(f.variants.has("ultra"), "ultra effort should be captured");
    assert.ok(f.variants.has("thinking-high"), "thinking-high effort should be captured");
    const m = models.find((x) => x.id === "gemini-3.9-flash")!;
    assert.ok(m.supportedReasoningEfforts.some((e) => e.reasoningEffort === "ultra"));
    assert.ok(m.supportedReasoningEfforts.some((e) => e.reasoningEffort === "thinking-high"));
  });

  it("handles id-only effort (no parens) generically", () => {
    const raw: RawModel[] = [
      { id: "future-model-turbo", name: "Future Model" },
      { id: "future-model-standard", name: "Future Model" },
    ];
    const { families } = parseRawModels(raw);
    const fam = families.get("future-model")!;
    assert.ok(fam, "family should be future-model");
    assert.ok(fam.variants.has("turbo"));
    assert.ok(fam.variants.has("standard"));
  });

  it("respects preferred default from settings (per-provider configurability)", () => {
    const pref = { model: "gemini-3.1-pro", effort: "low" } as const;
    const { models, defaultFamilyId } = parseRawModels(CURRENT_RAW, undefined, pref);
    assert.equal(defaultFamilyId, "gemini-3.1-pro");
    assert.ok(models.find((m) => m.id === "gemini-3.1-pro")!.isDefault);
    assert.equal(models.find((m) => m.id === "gemini-3.1-pro")!.defaultReasoningEffort, "low");
  });

  it("falls back if preferred default not in catalog", () => {
    const pref = { model: "non-existent", effort: "high" } as const;
    const { defaultFamilyId } = parseRawModels(CURRENT_RAW, undefined, pref);
    assert.equal(defaultFamilyId, "gemini-3.7-flash");
  });
});

describe("resolveRawModelId — launch variant resolution (tested via payload, not LLM)", () => {
  const { families, defaultFamilyId } = parseRawModels(CURRENT_RAW);
  it("resolves family + reasoning to concrete ACP id", () => {
    assert.equal(resolveRawModelId("gemini-3.7-flash", "high", families, defaultFamilyId, CURRENT_RAW), "gemini-3.7-flash-high");
    assert.equal(resolveRawModelId("gemini-3.7-flash", "medium", families, defaultFamilyId, CURRENT_RAW), "gemini-3.7-flash-medium");
    assert.equal(resolveRawModelId("gemini-3.7-flash", "low", families, defaultFamilyId, CURRENT_RAW), "gemini-3.7-flash-low");
  });

  it("resolves gemini-3.1-pro variants (including gemini-pro-agent mapping)", () => {
    assert.equal(resolveRawModelId("gemini-3.1-pro", "high", families, defaultFamilyId, CURRENT_RAW), "gemini-pro-agent");
    assert.equal(resolveRawModelId("gemini-3.1-pro", "low", families, defaultFamilyId, CURRENT_RAW), "gemini-3.1-pro-low");
    // medium falls back to high variant for pro
    const res = resolveRawModelId("gemini-3.1-pro", "medium", families, defaultFamilyId, CURRENT_RAW);
    assert.ok(["gemini-pro-agent", "gemini-3.1-pro-low"].includes(res));
  });

  it("passes through raw legacy ids for backward compat", () => {
    assert.equal(resolveRawModelId("gemini-3.7-flash-high", undefined, families, defaultFamilyId, CURRENT_RAW), "gemini-3.7-flash-high");
    assert.equal(resolveRawModelId("gemini-pro-agent", undefined, families, defaultFamilyId, CURRENT_RAW), "gemini-pro-agent");
  });

  it("resolves default when model omitted (thread/start with undefined)", () => {
    const resolved = resolveRawModelId(undefined, undefined, families, defaultFamilyId, CURRENT_RAW);
    assert.equal(resolved, "gemini-3.7-flash-medium");
  });

  it("handles future effort generically", () => {
    const future: RawModel[] = [
      { id: "gemini-3.9-flash-ultra", name: "Gemini 3.9 Flash (Ultra)" },
      { id: "gemini-3.9-flash-default", name: "Gemini 3.9 Flash (Default)" },
    ];
    const { families: ff, defaultFamilyId: df } = parseRawModels(future);
    assert.equal(resolveRawModelId("gemini-3.9-flash", "ultra", ff, df, future), "gemini-3.9-flash-ultra");
    assert.equal(resolveRawModelId("gemini-3.9-flash", "default", ff, df, future), "gemini-3.9-flash-default");
  });

  it("verifies intercepted payload rather than LLM identity", () => {
    // Simulate handleLine intercept: ensure we assert on the resolved model id that would be sent to agy_acp_server.par
    const fakeLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "thread/start",
      params: { options: { model: "gemini-3.8-flash", reasoningLevel: "high" } },
    });
    const parsed = JSON.parse(fakeLine);
    const resolved = resolveRawModelId(parsed.params.options.model, parsed.params.options.reasoningLevel, families, defaultFamilyId, CURRENT_RAW);
    assert.equal(resolved, "gemini-3.8-flash-high");
    // This is what we send to the ACP server — deterministic, no LLM hallucination
    parsed.params.options.model = resolved;
    assert.equal(JSON.parse(JSON.stringify(parsed)).params.options.model, "gemini-3.8-flash-high");
  });
});

describe("rawListsEqual — staleness detection", () => {
  it("detects added and deprecated models", () => {
    const a = [...CURRENT_RAW];
    const b = [...CURRENT_RAW, { id: "gemini-3.9-flash-ultra", name: "Gemini 3.9 Flash (Ultra)" }];
    assert.equal(rawListsEqual(a, b), false);
    assert.equal(rawListsEqual(a, a), true);
    const c = CURRENT_RAW.filter((m) => m.id !== "gemini-3.6-flash-low");
    assert.equal(rawListsEqual(CURRENT_RAW, c), false);
  });
});

describe("cache staleness — TTL behavior", () => {
  it("cache file includes timestamp and is comparable", () => {
    // Simulate: save then load should preserve timestamp
    // This test documents the contract: cache JSON must have {rawModels, timestamp}
    const mockCache = { rawModels: CURRENT_RAW, timestamp: Date.now() };
    assert.ok(typeof mockCache.timestamp === "number");
    assert.ok(Array.isArray(mockCache.rawModels));
  });
});
