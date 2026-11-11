import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
/** Bundle the spike into two self-contained files with alchemy's own bundler (no Docker):
 *   out/runner.mjs  the Effect Cluster runner + gateway hosting the model (effect-cluster internal/runner.ts)
 *   out/app.mjs     the app (Docker.Service bootstrap shim, run as a plain bun process)
 * Usage: bun build.ts <outDir> */
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Effect from "effect/Effect";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "out"));
const pkgs = path.resolve(here, "../../..");
const conditionNames = [...Bundle.NODE_CONDITION_NAMES];

const virtual = (id: string, source: string) => ({
  name: id,
  resolveId: (x: string) => (x === id ? `\0${id}` : null),
  load: (x: string) => (x === `\0${id}` ? source : null),
});

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const shim = path.join(here, ".app-entry.ts");
fs.writeFileSync(
  shim,
  `import { bootstrap } from "@alchemy.run/docker/Bootstrap";\nimport entrypoint from "./app.ts";\nawait bootstrap(entrypoint);\n`,
);

const program = Effect.gen(function* () {
  const runner = yield* Bundle.build(
    {
      input: path.join(pkgs, "effect-cluster/src/internal/runner.ts"),
      platform: "node",
      resolve: { conditionNames },
      plugins: [
        virtual(
          "virtual:cluster-entities",
          `import { SpikeLive as e0 } from ${JSON.stringify(path.join(here, "live.ts"))};\nexport default [{ name: "Spike", value: e0 }];`,
        ),
      ],
    },
    { dir: out, format: "esm", entryFileNames: "runner.mjs", codeSplitting: false },
  );
  const app = yield* Bundle.build(
    { input: shim, platform: "node", resolve: { conditionNames: ["bun", ...conditionNames] } },
    { dir: out, format: "esm", entryFileNames: "app.mjs", codeSplitting: false },
  );
  console.log(JSON.stringify({ out, runner: runner.hash, app: app.hash }));
});
await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<void>);
fs.rmSync(shim);
