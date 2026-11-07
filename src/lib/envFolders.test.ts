import { describe, expect, it } from "vitest";
import type { EnvironmentSet, FolderEnvironments, TreeNode } from "./types";
import { environmentNames, environmentsFor, folderLabel, nearestEnvFolder, folderOf, workspaceFolders, writeFolder } from "./envFolders";

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
    expect(folderOf("/ws", "/ws/api/users/list.http")).toBe("api/users");
    expect(folderOf("/ws", "/ws/top.http")).toBe("");
    expect(folderOf("C:\\ws", "C:\\ws\\api\\list.http")).toBe("api");
    expect(folderOf("/ws/", "/ws/api/list.http")).toBe("api");
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

describe("which folder's env files a new or changed value goes to", () => {
  // A request in api/users/: dev's public file is the root's, its private one api/'s; qa is only in api/'s private file.
  const effective: EnvironmentSet = {
    shared: [{ name: "version", value: "v1", secret: false }],
    sharedSource: { public: "api/users" },
    environments: [
      {
        name: "dev",
        source: { public: "", private: "api" },
        variables: [
          { name: "host", value: "h", secret: false },
          { name: "token", value: "t", secret: true },
        ],
      },
      { name: "qa", source: { private: "api" }, variables: [] },
    ],
    privateFileIgnored: null,
  };

  it("a value the environment has goes where it is: a Secret's to the private file's folder", () => {
    expect(writeFolder(effective, "dev", "host")).toBe("");
    expect(writeFolder(effective, "dev", "token")).toBe("api");
    expect(writeFolder(effective, "$shared", "version")).toBe("api/users");
  });

  it("a new one goes to the folder whose shareable file supplies the environment, so no farther file is hidden", () => {
    expect(writeFolder(effective, "dev", "port")).toBe("");
    expect(writeFolder(effective, "$shared", "region")).toBe("api/users");
    expect(writeFolder(effective, "qa", "port")).toBe("api");
  });

  it("is unknown for an environment the request doesn't get, or a set that doesn't say", () => {
    expect(writeFolder(effective, "staging", "host")).toBeUndefined();
    expect(writeFolder(set("dev"), "dev", "host")).toBeUndefined();
    expect(writeFolder(null, "dev", "host")).toBeUndefined();
  });

  it("every folder of the workspace, in explorer order, relative to the root", () => {
    const dir = (path: string, children: TreeNode[] = []): TreeNode => ({ name: path.split("/").at(-1)!, path, kind: "dir", children });
    const tree = dir("/ws", [dir("/ws/api", [dir("/ws/api/users"), { name: "a.http", path: "/ws/api/a.http", kind: "file" }]), dir("/ws/web")]);
    expect(workspaceFolders(tree, "/ws")).toEqual(["api", "api/users", "web"]);
    expect(workspaceFolders(null, "/ws")).toEqual([]);
  });

  it("the Environments modal opens on the nearest folder with env files at or above the request's", () => {
    const folders: FolderEnvironments[] = [
      { dir: "api", set: set("dev") },
      { dir: "api/users", set: set("dev") },
    ];
    expect(nearestEnvFolder(folders, "api/users/admin")).toBe("api/users");
    expect(nearestEnvFolder(folders, "api/orders")).toBe("api");
    expect(nearestEnvFolder(folders, "web")).toBe("");
  });
});
