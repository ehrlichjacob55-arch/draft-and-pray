import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const handlersDir = path.join(root, "src/handlers");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });

const handlers = (await readdir(handlersDir))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => f.replace(/\.ts$/, ""));

const banner =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

await Promise.all(
  handlers.map((name) =>
    build({
      entryPoints: [path.join(handlersDir, `${name}.ts`)],
      outfile: path.join(dist, name, "index.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      minify: false,
      sourcemap: "linked",
      external: ["@aws-sdk/*"],
      banner: { js: banner },
      logLevel: "warning",
    }),
  ),
);

console.log(`Built ${handlers.length} handlers: ${handlers.join(", ")}`);
