import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const extensionRoot = path.join(root, "extension");
const dist = path.join(root, "dist");
const unpacked = path.join(dist, "unpacked");
const zipPath = path.join(dist, "simple-track-email-tracker.zip");

await rm(dist, { recursive: true, force: true });
await mkdir(unpacked, { recursive: true });

const files = [
  "manifest.json",
  "assets",
  "src"
];

for (const file of files) {
  await cp(path.join(extensionRoot, file), path.join(unpacked, file), { recursive: true });
}

const command = [
  "Compress-Archive",
  "-Path",
  files.map((file) => `'${path.join(unpacked, file)}'`).join(","),
  "-DestinationPath",
  `'${zipPath}'`,
  "-Force"
].join(" ");

const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
  encoding: "utf8",
  stdio: "pipe"
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

console.log(`Prepared unpacked extension at ${unpacked}`);
console.log(`Packaged ${zipPath}`);
