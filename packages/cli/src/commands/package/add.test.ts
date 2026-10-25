import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../../paths.ts";
import { PRESETS, writePackage } from "./add.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** A manifest of the CLI with the ranges that a new package gets when the repository does not have them. */
const cli = {
  name: CLI_NAME,
  devDependencies: {
    "@mark1russell7/cue": "github:mark1russell7/cue",
    "@mark1russell7/service": "^0.5.8",
    "@types/node": "^26.0.0",
    typescript: "^7.0.0",
    vitest: "^5.0.0",
  },
};

/** A repository with the scope `demo` in a new temporary folder. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "template-cli-add-"));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-monorepo" }));
  return dir;
}

const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("writePackage", () => {
  it("writes a library package with an empty entry for the preset node", async () => {
    const root = repo();
    const written = await writePackage(root, "lib", "node", cli);
    expect(written).toMatchObject({ name: "@demo/lib", install: [] });
    expect(readFileSync(join(written.dir, "src", "index.ts"), "utf8")).toBe("export {};\n");
    const manifest = json(join(written.dir, "package.json"));
    expect(manifest["dependencies"]).toBeUndefined();
    expect(manifest["main"]).toBe("./src/index.ts");
    expect(json(join(written.dir, "tsconfig.json"))["extends"]).toBe("@mark1russell7/cue/ts/config/node.json");
  });

  it("writes the server entry of the preset service, on the range of @mark1russell7/service of the CLI", async () => {
    const root = repo();
    const written = await writePackage(root, "api", "service", cli);
    expect(written).toMatchObject({ name: "@demo/api", install: [] });
    const manifest = json(join(written.dir, "package.json"));
    expect(manifest["dependencies"]).toEqual({ "@mark1russell7/service": "^0.5.8" });
    expect(manifest["scripts"]).toMatchObject({ start: "node src/main.ts", test: "vitest run" });
    expect(json(join(written.dir, "tsconfig.json"))["extends"]).toBe("@mark1russell7/cue/ts/config/node.json");
    for (const file of ["api.ts", "index.ts", "index.test.ts", "main.ts"]) {
      const text = readFileSync(join(written.dir, "src", file), "utf8");
      expect(text, file).not.toContain("{{");
      // only the entry of the process starts the service
      expect(text.includes(".run("), file).toBe(file === "main.ts" || file === "index.test.ts");
    }
    expect(readFileSync(join(written.dir, "src", "index.ts"), "utf8")).toContain('service("api")');
    expect(existsSync(join(written.dir, "vitest.config.ts"))).toBe(true);
  });

  it("gives the pnpm add commands of a preset that installs its packages", async () => {
    const written = await writePackage(repo(), "web", "react", cli);
    expect(written.install).toEqual([
      "pnpm add --filter=@demo/web react react-dom",
      "pnpm add -D --filter=@demo/web vite @vitejs/plugin-react @types/react @types/react-dom",
    ]);
  });

  it("refuses a package that exists and a name that is not valid", async () => {
    const root = repo();
    await writePackage(root, "lib", "ts", cli);
    await expect(writePackage(root, "lib", "ts", cli)).rejects.toThrow(/already exists/);
    await expect(writePackage(root, "Lib", "ts", cli)).rejects.toThrow(/Invalid package name/);
  });
});

describe("the presets in CI", () => {
  it("each preset is in the matrix of the job presets of ci.yml", () => {
    const workflow = readFileSync(resolve(here, "..", "..", "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const matrix = /^\s*preset:\s*\[([^\]]*)\]/m.exec(workflow)?.[1];
    expect(matrix?.split(",").map((name) => name.trim())).toEqual(Object.keys(PRESETS));
  });
});
