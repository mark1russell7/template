// The check that a version already on npm still ships the same files.
//
// The release skips each version that npm already has. So when a pull request changes the code
// of a package but keeps its version (for example two pull requests that both set 0.1.23), the
// release publishes nothing, and its checks are green. This check compares the tarball that the
// release packed with the tarball that npm has for the same version, file by file. A difference
// makes the release fail with the names of the files, so the author sets a greater version.
//
// The compare reads the files in the tarballs, not the tarball bytes, so the tar and gzip
// metadata (times, order, compression) do not count. In package.json only the fields that change
// what a user installs count: devDependencies, and the scripts other than the install scripts,
// do not. So a pull request that only updates a development tool does not need a version.

import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall"]);

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function paxPath(data: Buffer): string | undefined {
  // Each record is "<length> <key>=<value>\n".
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) return undefined;
    const length = Number(data.subarray(offset, space).toString("utf8"));
    if (!Number.isInteger(length) || length <= 0) return undefined;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice("path=".length);
    offset += length;
  }
  return undefined;
}

/** The regular files of a .tgz, by path, with the first folder of each path ("package/") removed. */
export function tarballFiles(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  let next: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      next = paxPath(data);
      continue;
    }
    const prefix = text(header, 345, 155);
    const name = next ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    next = undefined;
    if (type !== "0" && type !== "\0") continue;
    files.set(name.replace(/^[^/]+\//u, ""), Buffer.from(data));
  }
  return files;
}

/** package.json with only the fields that change what a user installs, in a fixed key order. */
export function installedManifest(raw: Buffer): string {
  const manifest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  delete manifest["devDependencies"];
  const scripts = manifest["scripts"];
  if (scripts && typeof scripts === "object") {
    const kept = Object.fromEntries(Object.entries(scripts).filter(([name]) => INSTALL_SCRIPTS.has(name)));
    if (Object.keys(kept).length > 0) manifest["scripts"] = kept;
    else delete manifest["scripts"];
  }
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(sort(manifest));
}

/** The paths that differ between the published and the packed files: added, removed or changed. */
export function shippedDifferences(published: Map<string, Buffer>, packed: Map<string, Buffer>): string[] {
  const paths = [...new Set([...published.keys(), ...packed.keys()])].sort();
  return paths.flatMap((path) => {
    const before = published.get(path);
    const after = packed.get(path);
    if (before === undefined) return [`${path} (added)`];
    if (after === undefined) return [`${path} (removed)`];
    const same = path === "package.json" ? installedManifest(before) === installedManifest(after) : before.equals(after);
    return same ? [] : [`${path} (changed)`];
  });
}
