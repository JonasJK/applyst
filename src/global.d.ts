/// <reference types="@solidjs/start/env" />

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
  export function setImportWasmModule(loader: () => Promise<ArrayBuffer>): void;
}
