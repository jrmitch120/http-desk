import { describe, expect, it } from "vitest";
import type { EnvironmentSet, FolderEnvironments } from "./types";
import { environmentNames, environmentsFor, folderLabel, requestFolder } from "./envFolders";

const set = (...names: string[]): EnvironmentSet => ({
  shared: [],
  environments: names.map((name) => ({ name, variables: [{ name: "host", value: name, secret: false }] })),
  privateFileIgnored: null,
});

describe("per-directory environments on the frontend", () => {
  const root = set("dev", "prod");
  const folders: FolderEnvironments[] = [
    { dir: "api", set: set("dev", "prod", "qa") },
    { dir: "api/users", set: set("dev", "prod", "staging") },
    { dir: "web", set: set("dev", "prod", "preview") },
  ];

  it("a request's folder is its file's folder relative to the workspace root, on either separator", () => {
    expect(requestFolder("/ws", "/ws/api/users/list.http")).toBe("api/users");
    expect(requestFolder("/ws", "/ws/top.http")).toBe("");
    expect(requestFolder("C:\\ws", "C:\\ws\\api\\list.http")).toBe("api");
    expect(requestFolder("/ws/", "/ws/api/list.http")).toBe("api");
  });

  it("names a folder the way the strip and warnings do", () => {
    expect(folderLabel("api/users")).toBe("api/users/");
    expect(folderLabel("")).toBe("the workspace root");
  });

  it("a request uses the nearest folder with env files at or above its own, else the root's", () => {
    expect(environmentsFor(root, folders, "api/users")).toBe(folders[1].set);
    expect(environmentsFor(root, folders, "api/users/admin/v2")).toBe(folders[1].set);
    expect(environmentsFor(root, folders, "api/orders")).toBe(folders[0].set);
    // A folder named like another's prefix isn't inside it.
    expect(environmentsFor(root, folders, "apiv2")).toBe(root);
    expect(environmentsFor(root, folders, "")).toBe(root);
    expect(environmentsFor(null, [], "api")).toBe(null);
  });

  it("the picker lists every environment name in the workspace once, the root's first", () => {
    expect(environmentNames(root, folders)).toEqual(["dev", "prod", "qa", "staging", "preview"]);
    expect(environmentNames(null, [])).toEqual([]);
  });
});
