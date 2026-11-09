import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readReference } from "../data/reference.ts";
import type { ReferenceFile, ReferencePackage } from "../data/types.ts";
import { declarationKind, referenceLead, renderDoc, renderReferencePage, REFERENCE_SCRIPT } from "./reference.ts";
import type { PageOptions } from "./theme.ts";

const PAGE: PageOptions = { repository: "acme/widgets", base: "/widgets/", generatedAt: "2026-11-08T14:05:00Z", commit: null };

const LIB: ReferencePackage = {
      packageName: "@acme/lib",
      entries: [
        {
          subpath: ".",
          names: [
            { name: "Options", key: "build/index.d.ts#Options", isType: true, kind: "declaration" },
            { name: "layout", key: "build/index.d.ts#layout", isType: false, kind: "declaration" },
            { name: "ns", key: "build/ns.d.ts#*", isType: false, kind: "namespace" },
            { name: "Other", key: "other-pkg#Other", isType: false, kind: "external" },
          ],
        },
        { subpath: "./svg", names: [{ name: "layout", key: "build/index.d.ts#layout", isType: false, kind: "declaration" }, { name: "toSvg", key: "build/svg.d.ts#toSvg", isType: false, kind: "declaration" }] },
        { subpath: "./x.css", names: [] },
      ],
      declarations: {
        "build/index.d.ts#Options": { text: "interface Options {\n  readonly a?: number;\n}", doc: "The options of {@link layout}." },
        "build/index.d.ts#layout": { text: "export declare function layout(options: Options): void;", doc: "The layout of a tree.\n\n@param options - The <options>.\n@returns Nothing." },
        "build/svg.d.ts#toSvg": { text: "export declare function toSvg(): string;" },
      },
};

const FILE: ReferenceFile = { format: "api-model/1", packages: [LIB] };

describe("the kind of a declaration", () => {
  it("reads the first keyword after export, default and declare", () => {
    expect(declarationKind("export declare function f(): void;")).toBe("function");
    expect(declarationKind("interface I {}")).toBe("interface");
    expect(declarationKind("declare abstract class A {}")).toBe("class");
    expect(declarationKind("export declare const enum E {}")).toBe("enum");
    expect(declarationKind("export declare const c: 1;")).toBe("constant");
    expect(declarationKind("type T = 1;")).toBe("type");
    expect(declarationKind("declare module 'm' {}")).toBe("namespace");
    expect(declarationKind("export = run;")).toBe("declaration");
  });
});

describe("the HTML of a doc comment", () => {
  it("gives paragraphs, a list, a code fence and the block tags, and escapes the text", () => {
    const html = renderDoc("First <b> line\ncontinues.\n\n- one\n- two\n  more\n\n```ts\nconst a = 1 < 2;\n```\n@param a - The value.\n@throws Error\n@internal");
    expect(html).toContain("<p>First &lt;b&gt; line continues.</p>");
    expect(html).toContain("<ul><li>one</li><li>two more</li></ul>");
    expect(html).toContain('<pre class="sp-ref-code"><code>const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain("<dt>Parameter <code>a</code></dt><dd><p>The value.</p></dd>");
    expect(html).toContain("<dt>Throws</dt><dd><p>Error</p></dd>");
    expect(html).not.toContain("internal");
  });

  it("does not show the tags for the authors of the code, also with text", () => {
    const html = renderDoc("Text.\n@internal Only for the tests.\n@privateRemarks A note.\n@hidden");
    expect(html).toBe("<p>Text.</p>");
  });

  it("reads an example without a fence as code, and a tag inside a fence as code", () => {
    expect(renderDoc("@example\nf(1);\n  g(2);")).toContain('<dt>Example</dt><dd><pre class="sp-ref-code"><code>f(1);\n  g(2);</code></pre></dd>');
    const fenced = renderDoc("Text.\n```\n@param no\n```");
    expect(fenced).toContain("<code>@param no</code>");
    expect(fenced).not.toContain("<dt>");
  });

  it("links a {@link} to the article of a name, and gives code for an unknown name", () => {
    const anchorOf = (name: string): string | undefined => (name === "layout" ? "layout" : undefined);
    expect(renderDoc("See {@link layout}.", anchorOf)).toContain('<a href="#layout"><code>layout</code></a>');
    expect(renderDoc("See {@link layout | the layout}.", anchorOf)).toContain('<a href="#layout">the layout</a>');
    expect(renderDoc("See {@link gone}.", anchorOf)).toContain("<code>gone</code>");
    expect(renderDoc("See {@link https://example.com the site}.")).toContain('<a href="https://example.com">the site</a>');
  });

  it("marks a deprecated tag", () => {
    expect(renderDoc("@deprecated Use g.")).toContain('<div class="sp-ref-deprecated"><dt>Deprecated</dt>');
  });
});

describe("the reference page", () => {
  const html = renderReferencePage(FILE, PAGE);

  it("shows each entry with its import path, and each declaration one time", () => {
    expect(html).toContain("<h1>Reference</h1>");
    expect(html).toContain("<code>@acme/lib</code>");
    expect(html).toContain("<code>@acme/lib/svg</code>");
    expect(html.match(/id="layout"/g)).toHaveLength(1);
    expect(html).toContain('The entry also exports <a href="#layout"><code>layout</code></a>. An earlier entry shows its declaration.');
    expect(html).toContain("This entry has no declaration file.");
  });

  it("shows the kind, the doc comment and the declaration of each name", () => {
    expect(html).toContain('<h4><a href="#Options">Options</a> <span class="sp-pill">interface</span> <span class="sp-pill">type only</span></h4>');
    expect(html).toContain('The options of <a href="#layout"><code>layout</code></a>.');
    expect(html).toContain("<dt>Parameter <code>options</code></dt><dd><p>The &lt;options&gt;.</p></dd>");
    expect(html).toContain("export declare function toSvg(): string;");
    expect(html).toContain("The entry exports this name of the package <code>other-pkg</code>.");
    expect(html).toContain('<span class="sp-pill">namespace</span>');
  });

  it("has the lead, the filter, the script and the current link of the navigation", () => {
    expect(referenceLead(FILE)).toBe("5 exports in 3 entry points of @acme/lib. 2 of them have a doc comment.");
    expect(html).toContain('<input class="sp-ref-input" id="sp-ref-filter" type="search"');
    expect(html).toContain(REFERENCE_SCRIPT);
    expect(html).toContain('<a href="/widgets/reference/" aria-current="page">Reference</a>');
    expect(html).toContain('href="/widgets/data/reference.json"');
  });

  it("puts the name of the package before each anchor when the file has more packages", () => {
    const two = renderReferencePage({ ...FILE, packages: [LIB, { ...LIB, packageName: "@acme/two" }] }, PAGE);
    expect(two).toContain('id="-acme-lib--layout"');
    expect(two).toContain('id="-acme-two--layout"');
  });
});

/**
 * The file of the format `api-model/1` that two packages hold. The test of api-report compares the output of
 * `api-report model` with it, so a change of the writer or of this reader fails a test.
 */
const SHARED = new URL("../../../api-report/test/fixtures/api-model-1.json", import.meta.url);

describe("the shared file of the format api-model/1", () => {
  const text = readFileSync(SHARED, "utf8");
  const file = readReference(text);

  it("reads each field of the output of api-report model", () => {
    expect(file).toEqual(JSON.parse(text));
  });

  it("renders each name, its doc comment and its declaration", () => {
    const html = renderReferencePage(file, PAGE);
    for (const id of ["Options", "layout", "many", "ns", "ns.inner", "version", "toSvg", "Other"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('The options of <a href="#layout"><code>layout</code></a>.');
    expect(html).toContain("<ul><li>It reads the options.</li><li>It gives nothing.</li></ul>");
    expect(html).toContain("<dt>Parameter <code>options</code></dt><dd><p>The &lt;options&gt;.</p></dd>");
    expect(html).toContain('<dt>Example</dt><dd><pre class="sp-ref-code"><code>layout({ gap: 2 });</code></pre></dd>');
    expect(html).toContain('<div class="sp-ref-deprecated"><dt>Deprecated</dt>');
    expect(html).toContain("The version of the package.");
    expect(html).not.toContain("Only for the tests.");
    expect(html).toContain("This entry has no declaration file.");
  });
});
