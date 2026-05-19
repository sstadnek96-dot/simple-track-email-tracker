import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const extensionRoot = path.join(root, "extension");
const manifestPath = path.join(extensionRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const requiredFiles = new Set();

requiredFiles.add(manifest.action.default_popup);
requiredFiles.add(manifest.background.service_worker);
requiredFiles.add(manifest.options_page);

for (const iconPath of Object.values(manifest.icons || {})) {
  requiredFiles.add(iconPath);
}

for (const script of manifest.content_scripts || []) {
  for (const jsPath of script.js || []) requiredFiles.add(jsPath);
  for (const cssPath of script.css || []) requiredFiles.add(cssPath);
}

const failures = [];

for (const file of requiredFiles) {
  try {
    await access(path.join(extensionRoot, file));
  } catch {
    failures.push(`Missing manifest file: ${file}`);
  }
}

const jsFiles = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((script) => script.js || []),
  "src/popup/popup.js",
  "src/options/options.js",
  "scripts/package-extension.mjs"
];

for (const file of jsFiles) {
  const scriptPath = file.startsWith("scripts/")
    ? path.join(root, file)
    : path.join(extensionRoot, file);
  const result = spawnSync(process.execPath, ["--check", scriptPath], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    failures.push(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

const functionsCheck = spawnSync(process.execPath, ["--check", path.join(root, "functions/src/index.js")], {
  encoding: "utf8"
});

if (functionsCheck.status !== 0) {
  failures.push(`Syntax check failed for functions/src/index.js\n${functionsCheck.stderr || functionsCheck.stdout}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`Validated ${requiredFiles.size} manifest assets and ${jsFiles.length} JavaScript files.`);
