// Metro config for the pnpm monorepo. The driver app lives in `frontend/driver`
// but shares `@medrush/contracts` from the workspace root, so Metro must watch
// the root and resolve modules from both node_modules trees.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// pnpm symlinks packages into a virtual store; keep resolution deterministic.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
