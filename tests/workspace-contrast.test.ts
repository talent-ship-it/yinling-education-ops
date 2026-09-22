import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/workspace-design.css", import.meta.url), "utf8");
const luminance = (hex: string) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}` : hex;
  const channels = [1, 3, 5].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};

test("task and ledger metadata palette meets 4.5:1 on every supported surface in light and dark mode", () => {
  const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)]
    .filter((match) => match[1]!.includes("--surface-raised:#"));
  assert.equal(roots.length, 2);
  for (const root of roots) {
    const tokens = Object.fromEntries([...root[1]!.matchAll(/(--[\w-]+):\s*(#[\da-f]+)/gi)].map((match) => [match[1], match[2]]));
    for (const [foreground, background] of [
      ["--muted", "--surface-raised"], ["--muted", "--surface-muted"],
      ["--muted", "--surface-tint"], ["--brand-ink", "--brand-soft"], ["--ink", "--surface-raised"],
    ]) {
      const values = [luminance(tokens[foreground!]!), luminance(tokens[background!]!)].sort((a, b) => b - a);
      const contrast = (values[0]! + 0.05) / (values[1]! + 0.05);
      assert.ok(contrast >= 4.5, `${foreground} on ${background}: ${contrast.toFixed(2)}:1`);
    }
  }
});
