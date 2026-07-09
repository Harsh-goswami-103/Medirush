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
// pnpm keeps a package's deps in its own `.pnpm/<pkg>/node_modules` dir, so Metro
// MUST walk the node_modules hierarchy (do NOT disable hierarchical lookup) and
// follow the store's symlinks to resolve transitive deps like @expo/metro-runtime.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
