import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/agent/index.ts",
    "src/cli/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  external: [
    // TUI deps — CLI-only, kept external so library consumers don't pull them in
    "ink",
    "react",
  ],
});
