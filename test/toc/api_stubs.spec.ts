/**
 * TOC live view test — ApiStubsAddon
 *
 * Automated verification for the M019 3rd-party addon API gap analysis.
 * The fixture calls every stub added in rounds 1 and 2 (Category A globals,
 * Category B namespace stubs). A sandbox crash from any missing/nil API would
 * surface as an entry in the errors array.
 *
 * StatusBar fill return values (value/min/max) are confirmed through FrameIR
 * fields (statusBarFill, statusBarFillColor) that ARE serialized to IR.
 *
 * Fixture: test/fixtures/ApiStubsAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { runTocFixture } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/ApiStubsAddon");

// ---------------------------------------------------------------------------
// No-crash guard — all M019 stubs must be callable without Lua errors
// ---------------------------------------------------------------------------

test("ApiStubsAddon — no Lua errors from M019 stubs", async () => {
  const errors: string[] = [];
  await runTocFixture(FIXTURE_DIR, { errors });
  expect(errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// StatusBar frame created and fill fraction correctly computed
// ---------------------------------------------------------------------------

test("ApiStubsAddon — StatusBar fill fraction from SetValue", async () => {
  const frames = await runTocFixture(FIXTURE_DIR);

  const bar = frames.find((f) => f.name === "ApiStubsBar");
  expect(bar).toBeDefined();
  expect(bar!.kind).toBe("StatusBar");
  expect(bar!.size).toEqual({ x: 200, y: 20 });

  // SetMinMaxValues(0, 100) + SetValue(75) → fill = 0.75
  expect(bar!.statusBarFill).toBeCloseTo(0.75, 5);
});

// ---------------------------------------------------------------------------
// StatusBar fill color propagated through IR
// ---------------------------------------------------------------------------

test("ApiStubsAddon — StatusBar fill color from SetStatusBarColor", async () => {
  const frames = await runTocFixture(FIXTURE_DIR);

  const bar = frames.find((f) => f.name === "ApiStubsBar");
  expect(bar).toBeDefined();

  // SetStatusBarColor(0, 0.5, 1, 1)
  expect(bar!.statusBarFillColor).toBeDefined();
  expect(bar!.statusBarFillColor!.r).toBeCloseTo(0, 5);
  expect(bar!.statusBarFillColor!.g).toBeCloseTo(0.5, 5);
  expect(bar!.statusBarFillColor!.b).toBeCloseTo(1, 5);
  expect(bar!.statusBarFillColor!.a).toBeCloseTo(1, 5);
});
