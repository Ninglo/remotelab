import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, open, rename } from "node:fs/promises";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";

export const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
export async function fileManifest(root) {
  const entries = {};
  async function walk(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(
        `Symlink requires explicit materialization before migration: ${path}`,
      );
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name));
    } else if (stat.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      entries[relative(root, path)] = {
        size: stat.size,
        mode: stat.mode & 0o777,
        sha256: hash.digest("hex"),
      };
    } else throw new Error(`Unsupported file type: ${path}`);
  }
  await walk(resolve(root));
  return entries;
}
export const digestManifest = (manifest) =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
export async function durableRename(from, to) {
  await rename(from, to);
  for (const path of new Set([dirname(from), dirname(to)])) {
    const fd = await open(path, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
}
export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
