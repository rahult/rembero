import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [outputDirectory, projectRoot, sqliteVersion, sourceUrl, sourceSha3, emsdkImage] =
  process.argv.slice(2);

if (
  !outputDirectory ||
  !projectRoot ||
  !sqliteVersion ||
  !sourceUrl ||
  !sourceSha3 ||
  !emsdkImage
) {
  throw new Error(
    "usage: write-wasm-manifest <output> <project> <sqlite-version> <source-url> <source-sha3> <emsdk-image>",
  );
}

const digest = async (path, algorithm = "sha256") =>
  createHash(algorithm).update(await readFile(path)).digest("hex");

const artifactNames = [
  "sqlite3.mjs",
  "sqlite3.wasm",
  "sqlite3-worker1.mjs",
  "sqlite3-worker1-promiser.mjs",
];
const sourcePaths = [
  "native/rembero.c",
  "native/recursive.c",
  "native/sqlite-extension.h",
  "native/sqlite3-wasm-extra-init.c",
];

const artifacts = Object.fromEntries(
  await Promise.all(
    artifactNames.map(async (name) => [
      name,
      {
        bytes: (await readFile(resolve(outputDirectory, name))).byteLength,
        sha256: await digest(resolve(outputDirectory, name)),
      },
    ]),
  ),
);
const extensionSources = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      basename(path),
      { sha256: await digest(resolve(projectRoot, path)) },
    ]),
  ),
);

await writeFile(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      format: "rembero.sqlite-wasm.v1",
      generatedAt: new Date().toISOString(),
      sqlite: {
        version: sqliteVersion,
        sourceUrl,
        sourceSha3_256: sourceSha3,
      },
      toolchain: { emsdkImage },
      extension: {
        registration: "sqlite3_auto_extension(sqlite3_rembero_init)",
        dynamicallyLoaded: false,
        sources: extensionSources,
      },
      artifacts,
    },
    null,
    2,
  )}\n`,
);
