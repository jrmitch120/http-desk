// Dev-only: the core's `.http` parser and serializer, built to WASM
// (crates/httpdesk-text-wasm), so the mock reads and writes `.http` text exactly
// as the shell does. Loaded only by the mock, so never in production builds.
// The Vite dev server builds the WASM (`textCoreWasm` in scripts/textCoreWasm.ts).
import wasmBase64 from "virtual:httpdesk-text-wasm";

interface Exports {
  memory: WebAssembly.Memory;
  text_alloc(len: number): number;
  text_invoke(command: number, commandLen: number, args: number, argsLen: number): number;
  text_output(): number;
  text_output_len(): number;
}

const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
const core = (await WebAssembly.instantiate(bytes)).instance.exports as unknown as Exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `text` copied into the module's memory; the core frees it. */
function pass(text: string): [number, number] {
  const encoded = encoder.encode(text);
  const ptr = core.text_alloc(encoded.length);
  new Uint8Array(core.memory.buffer, ptr, encoded.length).set(encoded);
  return [ptr, encoded.length];
}

/**
 * Runs core command `command` with `args` (as the shell's command of that name
 * takes them, e.g. `{ text }` for `parse_request`) and gives back its result.
 * Throws the core's message when it fails.
 */
export function invokeCore<T>(command: string, args: Record<string, unknown>): T {
  const ok = core.text_invoke(...pass(command), ...pass(JSON.stringify(args)));
  const output = decoder.decode(new Uint8Array(core.memory.buffer, core.text_output(), core.text_output_len()));
  if (!ok) throw new Error(output);
  return JSON.parse(output) as T;
}
