/**
 * The model of the public API of a package, as data. It has each entry, the names of each entry, the
 * declaration of each name and the text of its doc comment. A page of each export, or a page of a site,
 * renders this model. The report has the same entries, names and declarations, but no doc comments.
 */
import { documentedPackageReport, type PackageReportOptions } from "./report.ts";

/** The kind of a name of an entry: a declaration, a namespace, a name of a different package or an ambient declaration. */
export type ApiNameKind = "declaration" | "namespace" | "external" | "ambient";

/** One name of an entry of the model. */
export interface ApiName {
  /** The exported name. A member of a namespace has the name of the namespace first: `ns.name`. An ambient declaration has the name `ambient`. */
  readonly name: string;
  /** The key of the declaration of the name in `declarations`. For an external name, the key is the package and the name: `pkg#name`. */
  readonly key: string;
  /** True when the entry exports the name as a type only. */
  readonly isType: boolean;
  /** The kind of the name. */
  readonly kind: ApiNameKind;
}

/** One entry point of the package: its subpath and its names. */
export interface ApiEntry {
  /** The subpath of the entry in the field `exports`: `.` or `./svg`. */
  readonly subpath: string;
  /** The names of the entry, in the order of the report. An entry without a declaration file has no names. */
  readonly names: readonly ApiName[];
}

/** The declaration of one key, and the text of its doc comment. */
export interface ApiDeclaration {
  /** The text of the declaration, as the report gives it: without comments and private members. */
  readonly text: string;
  /** The text of the doc comment of the declaration, without the comment marks. A declaration without a doc comment has no doc. */
  readonly doc?: string;
}

/** The model of the public API of one package. */
export interface ApiModel {
  /** The name of the package. */
  readonly packageName: string;
  /** The entry points of the package, in the order of the report. */
  readonly entries: readonly ApiEntry[];
  /** The declaration of each key of the names. Each key has the form `file#name`. */
  readonly declarations: Readonly<Record<string, ApiDeclaration>>;
}

/**
 * This function gives the model of a report. `docs` gives the text of the doc comment of each key. The
 * report has no doc comments, so without `docs` the model has no doc comments.
 */
export function apiModel(report: string, packageName: string, docs: ReadonlyMap<string, string> = new Map()): ApiModel {
  const entries: ApiEntry[] = [];
  const declarations: Record<string, ApiDeclaration> = {};
  let names: ApiName[] | null = null;
  let key: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (key === null) return;
    const doc = docs.get(key);
    declarations[key] = { text: body.join("\n").trimEnd(), ...(doc === undefined ? {} : { doc }) };
  };
  let inDeclarations = false;
  for (const line of report.replace(/\r\n/g, "\n").split("\n")) {
    if (inDeclarations) {
      const next = /^### (.+)$/.exec(line)?.[1];
      if (next === undefined) body.push(line);
      else {
        close();
        key = next;
        body = [];
      }
      continue;
    }
    if (line.startsWith("## ")) {
      inDeclarations = line === "## Declarations";
      const subpath = /^## (\.\S*?)(?: \(.*\))?: /.exec(line)?.[1];
      names = null;
      if (subpath !== undefined) {
        const lines: ApiName[] = [];
        entries.push({ subpath, names: lines });
        if (line.endsWith(" names")) names = lines;
      }
      continue;
    }
    if (names === null) continue;
    const match = /^(type )?(.+?): (\S+)(?: \((namespace|external)\))?$/.exec(line);
    if (match === null) continue;
    const name = match[2] ?? "";
    const kind: ApiNameKind = name === "ambient" ? "ambient" : ((match[4] as "namespace" | "external" | undefined) ?? "declaration");
    names.push({ name, key: match[3] ?? "", isType: match[1] !== undefined, kind });
  }
  close();
  return { packageName, entries, declarations };
}

/** The format tag of the file of the command `api-report model`. A reader refuses a file with a different tag. */
export const MODEL_FORMAT = "api-model/1";

/** The file of the command `api-report model`: the format tag and the model of each package. */
export interface ApiModelFile {
  /** The format tag, `api-model/1`. */
  readonly format: typeof MODEL_FORMAT;
  /** The model of each package, in the order of the folders. */
  readonly packages: readonly ApiModel[];
}

/** This function gives the model of the package in the folder `dir`, with the doc comments of its built `.d.ts` files. */
export function packageModel(dir: string, options: PackageReportOptions = {}): ApiModel {
  const { packageName, text, docs } = documentedPackageReport(dir, options);
  return apiModel(text, packageName, docs);
}
