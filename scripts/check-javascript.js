const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules"]);

function findJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const files = findJavaScriptFiles(projectRoot).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`[UGF] JavaScript syntax check passed for ${files.length} files`);
