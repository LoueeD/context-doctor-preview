#!/usr/bin/env node
const { satisfies } = require("semver");
const { engines } = require("../package.json");

const version = process.versions.node;

if (!satisfies(version, engines.node)) {
  console.error(
    `Context Doctor requires Node.js ${engines.node}. This command is running Node.js ${version}.`,
  );
  console.error("Put a supported Node.js version on PATH, check node --version, and retry.");
  process.exitCode = 2;
} else {
  import("../dist/cli.mjs").catch((error) => {
    console.error("Context Doctor: " + error.message);
    process.exitCode = 2;
  });
}
