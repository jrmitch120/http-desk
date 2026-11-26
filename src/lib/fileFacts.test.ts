import { describe, expect, it } from "vitest";
import { fileFacts } from "./fileFacts";

describe("fileFacts", () => {
  it("names an LF file's endings, kept as the file has them", () => {
    expect(fileFacts({ lineEnding: "lf", bom: false }).endings).toEqual({
      label: "LF",
      tooltip: "Line endings: LF. HttpDesk keeps them as the file has them.",
    });
  });
  it("names a CRLF file's endings, kept as the file has them", () => {
    expect(fileFacts({ lineEnding: "crlf", mixedEndings: false, bom: false }).endings).toEqual({
      label: "CRLF",
      tooltip: "Line endings: CRLF. HttpDesk keeps them as the file has them.",
    });
  });
  it("calls a file with both endings Mixed: each line keeps its own, a new line gets the file's most common one", () => {
    expect(fileFacts({ lineEnding: "crlf", mixedEndings: true, bom: false }).endings).toEqual({
      label: "Mixed",
      tooltip: "Line endings: mixed CRLF and LF. HttpDesk keeps each line's own ending; a new line gets CRLF, the file's most common.",
    });
    expect(fileFacts({ lineEnding: "lf", mixedEndings: true, bom: false }).endings.tooltip).toBe(
      "Line endings: mixed CRLF and LF. HttpDesk keeps each line's own ending; a new line gets LF, the file's most common.",
    );
  });
  it("calls a file without a BOM UTF-8", () => {
    expect(fileFacts({ lineEnding: "lf", bom: false }).encoding).toEqual({
      label: "UTF-8",
      tooltip: "Encoding: UTF-8, without a byte order mark (BOM). HttpDesk saves it without one.",
    });
  });
  it("calls a file that starts with a BOM UTF-8 BOM, kept on save, whatever its endings", () => {
    const bom = { label: "UTF-8 BOM", tooltip: "Encoding: UTF-8, starting with a byte order mark (BOM). HttpDesk keeps the BOM on save." };
    expect(fileFacts({ lineEnding: "lf", bom: true })).toEqual({
      endings: { label: "LF", tooltip: "Line endings: LF. HttpDesk keeps them as the file has them." },
      encoding: bom,
    });
    expect(fileFacts({ lineEnding: "crlf", mixedEndings: true, bom: true }).encoding).toEqual(bom);
  });
});
