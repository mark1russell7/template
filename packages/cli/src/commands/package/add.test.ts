import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../../paths.ts";
import { PRESETS, withAllowBuilds, writePackage } from "./add.ts";

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

  it("writes the three processes of the preset electron, and allows the install script of electron", async () => {
    const root = repo();
    const written = await writePackage(root, "desktop", "electron", cli);
    expect(written).toMatchObject({ name: "@demo/desktop", allowed: ["electron"] });
    expect(written.install).toEqual(["pnpm add -D --filter=@demo/desktop electron tsdown"]);
    const manifest = json(join(written.dir, "package.json"));
    expect(manifest["main"]).toBe("./src/index.ts");
    expect(manifest["scripts"]).toMatchObject({ build: "tsdown", smoke: "tsdown && electron build/main/main.js --smoke" });
    const files = ["src/index.ts", "src/index.test.ts", "src/main.ts", "src/preload.ts", "src/page.ts", "page/index.html", "page/page.css", "tsdown.config.ts"];
    for (const file of files) expect(readFileSync(join(written.dir, file), "utf8"), file).not.toContain("{{");
    expect(readFileSync(join(written.dir, "page", "index.html"), "utf8")).toContain("<title>desktop</title>");
    // The page gets no Electron API: only the preload script imports electron, and it gives the page a port
    expect(readFileSync(join(written.dir, "src", "page.ts"), "utf8")).not.toContain("electron");
    expect(readFileSync(join(written.dir, "src", "preload.ts"), "utf8")).not.toContain("contextBridge");
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("allowBuilds:\n  # electron: its install script");
    expect(workspace).toContain("  electron: true\n");
    // A second package keeps the entry, and adds no second one
    expect((await writePackage(root, "desktop-two", "electron", cli)).allowed).toEqual([]);
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
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

  it("leaves no folder when a range is not found, so a second attempt operates", async () => {
    const root = repo();
    const { "@mark1russell7/service": _, ...withoutService } = cli.devDependencies;
    await expect(writePackage(root, "api", "service", { ...cli, devDependencies: withoutService })).rejects.toThrow(/@mark1russell7\/service/);
    expect(existsSync(join(root, "packages", "api"))).toBe(false);
    await expect(writePackage(root, "api", "service", cli)).resolves.toMatchObject({ name: "@demo/api" });
  });
});

describe("withAllowBuilds", () => {
  const workspace = [
    'packages:\n  - "packages/*"',
    "",
    "allowBuilds:",
    '  "@mark1russell7/cue@git+https://github.com/mark1russell7/cue.git": true',
    "  esbuild: true",
    "  # A comment: the key in it is not an entry",
    '  "@swc/core": false',
    "",
    "trustPolicy: no-downgrade",
    "",
  ].join("\n");

  it("adds a package to the block, with its reason, and keeps the rest of the file", () => {
    const { text, added } = withAllowBuilds(workspace, { electron: "electron: a reason." });
    expect(added).toEqual(["electron"]);
    expect(text).toBe(workspace.replace("allowBuilds:\n", "allowBuilds:\n  # electron: a reason.\n  electron: true\n"));
  });

  it("keeps an entry that exists, also an entry with false, and quotes a name with a scope", () => {
    expect(withAllowBuilds(workspace, { esbuild: "x", "@swc/core": "y" })).toEqual({ text: workspace, added: [] });
    const { text } = withAllowBuilds(workspace, { "@scope/tool": "z" });
    expect(text).toContain('  "@scope/tool": true\n');
  });

  it("makes the block when the file has none, and reads a block at the end of the file", () => {
    const { text } = withAllowBuilds('packages:\n  - "packages/*"', { electron: "r" });
    expect(text).toBe('packages:\n  - "packages/*"\n\n# Packages allowed to run install scripts.\nallowBuilds:\n  # r\n  electron: true\n');
    expect(withAllowBuilds(text, { electron: "r" }).added).toEqual([]);
    expect(withAllowBuilds("allowBuilds:\r\n  electron: true\r\n", { electron: "r" }).added).toEqual([]);
  });
});

describe("the presets in CI", () => {
  it("each preset is in the matrix of the job presets of ci.yml", () => {
    const workflow = readFileSync(resolve(here, "..", "..", "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const matrix = /^\s*preset:\s*\[([^\]]*)\]/m.exec(workflow)?.[1];
    expect(matrix?.split(",").map((name) => name.trim())).toEqual(Object.keys(PRESETS));
  });
});
