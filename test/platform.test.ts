import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportedPlatform, MACOS_ONLY_MESSAGE } from "../src/platform.js";

test("accepts macOS and rejects Windows before operating on macOS-only paths", () => {
  assert.doesNotThrow(() => assertSupportedPlatform("darwin"));
  assert.throws(() => assertSupportedPlatform("win32"), new RegExp(MACOS_ONLY_MESSAGE));
});
