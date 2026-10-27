// sanitizer-hostile.test.ts — the untrusted-text sanitiser in src/domain/league/types.ts against
// text built to make it misbehave rather than to inject (plan 02 §6.2 stripping; plan 01 §4.4 step
// 2). The everyday stripping and the injection flags are tested in tests/mcp/envelope.test.ts and
// tests/domain/league/types.test.ts; Markdown links in tests/domain/league/untrusted-markdown.test.ts.
import { describe, expect, it } from "vitest";
import { sanitizeText, wrapUntrusted } from "../../../src/domain/league/types.js";

/** Object.prototype's members whose names fit the entity grammar (`[A-Za-z][A-Za-z0-9]{1,31}`). */
const PROTOTYPE_NAMES = [
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
] as const;

describe("a named entity decodes only from the sanitiser's own table", () => {
  it.each(PROTOTYPE_NAMES)("&%s; decodes to nothing, never to Object.prototype's text", (name) => {
    // before the fix `A&constructor;B` read "Afunction Object() { [native code] }B"
    expect(sanitizeText(`A&${name};B`, 400).value).toBe("AB");
    expect(wrapUntrusted(`Team A&${name};`, "espn.team.name").untrusted_text).toEqual({
      value: "Team A",
      source: "espn.team.name",
      chars: 6,
      truncated: false,
    });
  });

  it("every name in the table still decodes, and an unknown name still decodes to nothing", () => {
    expect(
      sanitizeText(
        "&amp;&quot;&apos;&ndash;&mdash;&hellip;&lsquo;&rsquo;&ldquo;&rdquo;" +
          "&eacute;&egrave;&aacute;&iacute;&oacute;&uacute;&ntilde;&uuml;&ouml;&auml;&ccedil;",
        400,
      ).value,
    ).toBe("&\"'–—…‘’“”éèáíóúñüöäç");
    expect(sanitizeText("a&nbsp;b &lt;i&gt;x&lt;/i&gt; c&bogus;d", 400).value).toBe("a b x cd");
  });
});
