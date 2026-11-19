// Vite dev-server plugin: builds the core's `.http` parser and serializer to WASM
// (crates/httpdesk-text-wasm) and serves it to the mocked backend as the module
// `virtual:httpdesk-text-wasm` (base64; see src/dev/textCore.ts). It builds on the
// first request for it, so `pnpm tauri dev`, which never loads the mock, never
// builds it, and it isn't applied to production builds at all.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const ID = "virtual:httpdesk-text-wasm";
const RESOLVED = `\0${ID}`;
const TARGET = "wasm32-unknown-unknown";
/** `cargo build` arguments, the same as `pnpm build:wasm`'s. */
const BUILD = ["build", "-p", "httpdesk-text-wasm", "--target", TARGET, "--release"];

interface CargoMessage {
  reason: string;
  target?: { name: string };
  filenames?: string[];
}

/** Builds the WASM (a no-op when it's up to date) and gives back its path. */
async function build(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("cargo", [...BUILD, "--message-format=json-render-diagnostics"], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e: any) {
    const missing = String(e?.stderr ?? "").includes(TARGET) ? `\nInstall the target once with \`rustup target add ${TARGET}\`.` : "";
    throw new Error(`Couldn't build the core's WASM for the mocked backend (cargo ${BUILD.join(" ")}).${missing}\n${e?.stderr ?? e}`);
  }
  const wasm = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as CargoMessage)
    .filter((m) => m.reason === "compiler-artifact" && m.target?.name === "httpdesk_text_wasm")
    .flatMap((m) => m.filenames ?? [])
    .find((f) => f.endsWith(".wasm"));
  if (!wasm) throw new Error("cargo built no httpdesk_text_wasm.wasm");
  return wasm;
}

export function textCoreWasm(): Plugin {
  return {
    name: "httpdesk-text-wasm",
    apply: "serve",
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    async load(id) {
      if (id !== RESOLVED) return;
      const bytes = await readFile(await build());
      return `export default ${JSON.stringify(bytes.toString("base64"))};`;
    },
  };
}
