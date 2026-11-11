import { describe, expect, it } from "vitest";
import { bmpImage, largeJson, toBase64 } from "./perfFixtures";

/** JSON.parse that keeps every number as written, so 19-digit ids survive a round trip. */
const parseLossless = (text: string) => {
  const J = JSON as any;
  return J.parse(text, (_k: string, v: unknown, ctx: { source?: string }) => (typeof v === "number" ? J.rawJSON(ctx.source) : v));
};

describe("largeJson", () => {
  it("is minified JSON of about the size asked for, its last item named by the given term", () => {
    const { json } = largeJson(200_000, "needle-near-the-end");
    expect(json.length).toBeGreaterThanOrEqual(200_000);
    expect(json.length).toBeLessThan(201_000);
    expect(json).not.toMatch(/\s/);
    const items = parseLossless(json).items;
    expect(items.length).toBeGreaterThan(100);
    expect(items.at(-1).name).toBe("needle-near-the-end");
    expect(json.indexOf("needle-near-the-end")).toBe(json.lastIndexOf("needle-near-the-end"));
  });

  it("has 19-digit ids, which a plain JSON.parse would round", () => {
    const { json } = largeJson(10_000, "x");
    const ids = [...json.matchAll(/"id":(\d+)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toHaveLength(19);
    expect(String(JSON.parse(json).items[0].id)).not.toBe(ids[0]);
  });

  it("comes with the same document pretty-printed, two-space indent, numbers as written", () => {
    const { json, pretty } = largeJson(20_000, "x");
    expect(pretty).toBe(JSON.stringify(parseLossless(json), null, 2));
  });

  it("at 50 MB pretty-prints to about 88 MB over millions of lines", () => {
    const { json, pretty } = largeJson(50_000_000, "x");
    expect(pretty.length / json.length).toBeGreaterThan(1.7);
    expect(pretty.length / json.length).toBeLessThan(1.82);
    let lines = 1;
    for (let i = pretty.indexOf("\n"); i !== -1; i = pretty.indexOf("\n", i + 1)) lines++;
    expect(lines).toBeGreaterThan(2_000_000);
  });
});

describe("bmpImage", () => {
  it("is a 24-bit BMP whose header gives its size and dimensions", () => {
    const bmp = bmpImage(4, 3);
    const view = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe("BM");
    expect(view.getUint32(2, true)).toBe(bmp.length);
    expect(view.getInt32(18, true)).toBe(4);
    expect(view.getInt32(22, true)).toBe(3);
    expect(view.getUint16(28, true)).toBe(24);
    // Rows are padded to four bytes: 4 px × 3 bytes = 12, no padding.
    expect(bmp.length).toBe(54 + 12 * 3);
  });
});

describe("toBase64", () => {
  it("encodes bytes as btoa would", () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) % 256);
    expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes.slice(0, 50_000)) + String.fromCharCode(...bytes.slice(50_000))));
  });
});
