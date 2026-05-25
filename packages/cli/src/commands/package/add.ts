import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { packagesDir, repoRoot } from "../../paths.ts";

async function getScope(): Promise<string> {
  const raw = await readFile(resolve(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { name?: string };
  const name = pkg.name ?? "";
  return name.endsWith("-monorepo") ? name.slice(0, -"-monorepo".length) : name;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const TSCONFIG_OPTIONS = [
  { value: "node", label: "node — Node.js library/CLI (ESM, NodeNext)" },
  { value: "node-cjs", label: "node-cjs — Node.js library (CJS)" },
  { value: "ts", label: "ts — generic TS library (ESM)" },
  { value: "vite", label: "vite — browser/bundler (Vite)" },
  { value: "react", label: "react — React + Vite" },
] as const;

type TsconfigPreset = (typeof TSCONFIG_OPTIONS)[number]["value"];
const PRESET_VALUES = TSCONFIG_OPTIONS.map((o) => o.value) as readonly string[];

function parseArgs(args: string[]): { name: string | undefined; preset: TsconfigPreset | undefined } {
  let name: string | undefined;
  let preset: TsconfigPreset | undefined;
  for (const a of args) {
    if (a.startsWith("--preset=")) {
      const v = a.slice("--preset=".length);
      if (!PRESET_VALUES.includes(v)) {
        throw new Error(`Unknown --preset "${v}". Allowed: ${PRESET_VALUES.join(", ")}`);
      }
      preset = v as TsconfigPreset;
    } else if (!name) {
      name = a;
    }
  }
  return { name, preset };
}

export async function addPackage(args: string[]): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("Could not derive package scope from root package.json (expected name to end with -monorepo).");
  }
  const parsed = parseArgs(args);
  let name = parsed.name;
  if (!name) {
    const answer = await p.text({
      message: `Package name (will be @${scope}/<name>)?`,
      validate: (v) => (NAME_RE.test(v) ? undefined : "lowercase letters, digits, hyphens; must start with letter/digit"),
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    name = answer;
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid package name "${name}". Allowed: ^[a-z0-9][a-z0-9-]*$`);
  }

  let preset: TsconfigPreset;
  if (parsed.preset) {
    preset = parsed.preset;
  } else {
    const presetAnswer = await p.select({
      message: "Pick a base tsconfig from @mark1russell7/cue:",
      options: TSCONFIG_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      initialValue: "node" as TsconfigPreset,
    });
    if (p.isCancel(presetAnswer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    preset = presetAnswer;
  }

  const dir = resolve(packagesDir, name);
  if (existsSync(dir)) {
    throw new Error(`Package already exists: packages/${name}`);
  }
  await mkdir(resolve(dir, "src"), { recursive: true });

  const pkgJson = {
    $schema: "https://json.schemastore.org/package",
    name: `@${scope}/${name}`,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "./src/index.ts",
    scripts: {
      test: "vitest run",
      "test:watch": "vitest",
      typecheck: "tsc --noEmit",
    },
    devDependencies: {
      "@mark1russell7/cue": "github:mark1russell7/cue",
      "@types/node": "^22.10.0",
      typescript: "^5.7.2",
      vitest: "^2.1.8",
    },
  };
  await writeFile(resolve(dir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const tsconfig = {
    $schema: "https://json.schemastore.org/tsconfig",
    extends: `@mark1russell7/cue/ts/config/${preset}.json`,
  };
  await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

  await writeFile(resolve(dir, "src", "index.ts"), `export {};\n`);

  await writeFile(
    resolve(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["src/**/*.{test,spec}.ts"],\n  },\n});\n`,
  );

  p.log.success(`Created packages/${name}/ extending cue ${preset}.json`);
  p.log.info(`Run 'pnpm install' to wire up the new workspace package.`);
}
