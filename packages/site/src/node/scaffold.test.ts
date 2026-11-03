import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presetLabels, scaffoldData } from "./scaffold.ts";

describe("the output of the CLI for each preset", () => {
  const data = scaffoldData({ devDependencies: { typescript: "^7.0.2" } });
  const preset = (name: string) => data.presets.find((p) => p.name === name);

  it("has each preset of the CLI, with its label", () => {
    expect(data.presets.map((p) => p.name)).toEqual(["node", "node-cjs", "ts", "vite", "react", "service"]);
    expect(preset("react")?.label).toMatch(/React/);
    expect(data.namePattern).toBe("^[a-z0-9][a-z0-9-]*$");
  });

  it("has the files that the CLI writes, with the marks of the name and the scope", () => {
    const files = preset("node")?.files.map((f) => f.path);
    expect(files).toEqual(["package.json", "src/index.test.ts", "src/index.ts", "tsconfig.json", "tsconfig.test.json", "vitest.config.ts"]);
    const manifest = JSON.parse(preset("node")?.files.find((f) => f.path === "package.json")?.text ?? "{}") as { name: string; devDependencies: Record<string, string> };
    expect(manifest.name).toBe(`@${data.scopeMark}/${data.nameMark}`);
    expect(manifest.devDependencies["typescript"]).toBe("^7.0.2");
    expect(preset("service")?.files.map((f) => f.path)).toContain("src/main.ts");
  });

  it("has the pnpm add commands of the presets vite and react", () => {
    expect(preset("node")?.install).toEqual([]);
    expect(preset("vite")?.install).toEqual([`pnpm add -D --filter=@${data.scopeMark}/${data.nameMark} vite`]);
    expect(preset("react")?.install[0]).toContain("react react-dom");
  });
});

describe("the labels of the presets", () => {
  it("come from the source of the CLI", () => {
    const source = readFileSync(new URL("../../../cli/src/commands/package/add.ts", import.meta.url), "utf8");
    expect(Object.keys(presetLabels(source))).toEqual(["node", "node-cjs", "ts", "vite", "react", "service"]);
  });
});
