import { describe, expect, it } from "vitest";
import { SourceProblems } from "./problems.svelte";
import { newRequest } from "./http";
import type { Request, RequestProblems } from "./types";

/** A promise and the function settling it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const read = (line: number): RequestProblems => ({
  problems: [{ line, column: 1, severity: "error", code: "unparseable-request-line", message: "m" }],
  files: [],
});

describe("what the core found in each request's source", () => {
  it("is the latest answer, kept while a newer version of the request is asked about", async () => {
    const answers: ReturnType<typeof deferred<RequestProblems>>[] = [];
    const found = new SourceProblems({
      requestProblems: () => {
        answers.push(deferred());
        return answers.at(-1)!.promise;
      },
      bodyFileExists: async () => true,
    });
    const req: Request = newRequest();
    expect(found.read("k")).toBeUndefined();

    void found.refresh("k", req);
    answers[0].resolve(read(1));
    await answers[0].promise;
    await Promise.resolve();
    expect(found.read("k")?.read).toEqual(read(1));

    // Edited twice; the older reading answers last, and doesn't replace the newer.
    req.url = "a";
    void found.refresh("k", req);
    req.url = "b";
    void found.refresh("k", req);
    expect(found.read("k")?.read).toEqual(read(1));
    answers[2].resolve(read(3));
    await answers[2].promise;
    await Promise.resolve();
    answers[1].resolve(read(2));
    await answers[1].promise;
    await Promise.resolve();
    expect(found.read("k")).toEqual({ snap: JSON.stringify(req), read: read(3) });
  });

  it("can be given a reading directly, as a live edit of the source finds it", () => {
    const found = new SourceProblems({ requestProblems: () => new Promise(() => {}), bodyFileExists: async () => true });
    found.put("k", "{}", read(4));
    expect(found.read("k")).toEqual({ snap: "{}", read: read(4) });
  });
});

describe("whether a body file exists", () => {
  it("is the shell's answer, kept per path from the .http file's folder, and unknown until it answers", async () => {
    const asked: [string, string][] = [];
    const found = new SourceProblems({
      requestProblems: async () => read(1),
      bodyFileExists: async (file, path) => {
        asked.push([file, path]);
        if (path === "./broken.json") throw new Error("no");
        return path === "./there.json";
      },
    });
    expect(found.exists("/ws/api/a.http", "./there.json")).toBeUndefined();
    await found.check("/ws/api/a.http", "./there.json");
    await found.check("/ws/api/a.http", "./gone.json");
    await found.check("/ws/api/a.http", "./broken.json");
    expect(found.exists("/ws/api/a.http", "./there.json")).toBe(true);
    // Another file in the same folder shares the answer; one in another folder doesn't.
    expect(found.exists("/ws/api/b.http", "./gone.json")).toBe(false);
    expect(found.exists("/ws/other/a.http", "./gone.json")).toBeUndefined();
    // A failed question leaves it unknown, so it isn't flagged.
    expect(found.exists("/ws/api/a.http", "./broken.json")).toBeUndefined();
    expect(asked).toEqual([
      ["/ws/api/a.http", "./there.json"],
      ["/ws/api/a.http", "./gone.json"],
      ["/ws/api/a.http", "./broken.json"],
    ]);
  });
});
