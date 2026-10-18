import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMinGit } from "./prepare-mingit.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
// A real, stored ZIP containing cmd/git.exe; keep extraction tests independent of other archivers.
const zipFixture = Buffer.from(
  "UEsDBBQAAAAAAAAAIVg+4UUZGgAAABoAAAALAAAAY21kL2dpdC5leGVmaXh0dXJlIE1pbkdpdCBleGVjdXRhYmxlClBLAQIUABQAAAAAAAAAIVg+4UUZGgAAABoAAAALAAAAAAAAAAAAAACAAQAAAABjbWQvZ2l0LmV4ZVBLBQYAAAAAAQABADkAAABDAAAAAAA=",
  "base64",
);

test("extracts a verified real zip with the default extractor and reuses its archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    const cacheDir = path.join(root, "cache");
    const outputDir = path.join(root, "resources", "mingit");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "mingit.zip"), zipFixture);
    const result = await prepareMinGit({
      manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: hash(zipFixture) },
      cacheDir,
      outputDir,
      download: async () => assert.fail("a verified cached ZIP must not be downloaded again"),
      probe: async (command) => await readFile(command, "utf8") === "fixture MinGit executable\n",
    });

    assert.equal(result, "prepared");
    assert.equal(await readFile(path.join(outputDir, "cmd", "git.exe"), "utf8"), "fixture MinGit executable\n");
    assert.deepEqual(await readdir(path.dirname(outputDir)), ["mingit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans a failed real extraction without replacing the existing output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    const outputDir = path.join(root, "resources", "mingit");
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "keep.txt"), "previous installation");
    const invalidZip = Buffer.from("not a ZIP archive");
    await assert.rejects(prepareMinGit({
      manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: hash(invalidZip) },
      cacheDir: path.join(root, "cache"),
      outputDir,
      download: async (_url, destination) => writeFile(destination, invalidZip),
      probe: async () => false,
    }));

    assert.equal(await readFile(path.join(outputDir, "keep.txt"), "utf8"), "previous installation");
    assert.deepEqual(await readdir(path.dirname(outputDir)), ["mingit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a downloaded archive with the wrong sha256", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    await assert.rejects(
      prepareMinGit({
        manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: "0".repeat(64) },
        cacheDir: path.join(root, "cache"),
        outputDir: path.join(root, "resources", "mingit"),
        download: async (_url, destination) => writeFile(destination, "bad archive"),
        extract: async () => undefined,
        probe: async () => true,
      }),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses a verified extracted git executable without downloading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    const outputDir = path.join(root, "resources", "mingit");
    await mkdir(path.join(outputDir, "cmd"), { recursive: true });
    await writeFile(path.join(outputDir, "cmd", "git.exe"), "fake");
    let downloaded = false;
    const result = await prepareMinGit({
      manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: hash("archive") },
      cacheDir: path.join(root, "cache"),
      outputDir,
      download: async () => { downloaded = true; },
      extract: async () => undefined,
      probe: async () => true,
    });

    assert.equal(result, "cached");
    assert.equal(downloaded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
