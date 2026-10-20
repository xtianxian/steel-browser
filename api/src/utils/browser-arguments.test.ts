import { describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { browserDefaultArgsToIgnore } from "./browser-arguments.js";
const flags = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
function effective(args: string[], filtered: string[] = []) {
  const ignored = browserDefaultArgsToIgnore(args, filtered);
  return puppeteer.defaultArgs({ args }).filter((arg) => !ignored.includes(arg));
}
describe("Chrome background defaults with real Puppeteer arguments", () => {
  it("allows extension loading and normal background scheduling by default", () => {
    const args = effective([]);
    for (const flag of [...flags, "--enable-automation", "--disable-extensions"])
      expect(args).not.toContain(flag);
  });
  for (const flag of flags)
    it(`preserves the explicit opt-out ${flag}`, () => {
      expect(effective([flag])).toContain(flag);
    });
  it("retains the explicit filter's precedence over supplied arguments", () => {
    for (const flag of flags) expect(effective([flag], [flag])).not.toContain(flag);
  });
});
