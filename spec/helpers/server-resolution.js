const path = require("node:path");

function resolutionContext(context = {}) {
  const clientPath =
    typeof lumine === "undefined"
      ? process.env.LUMINE_TEST_CLIENT_PATH
      : lumine.packages.resolvePackagePath("ide-client");
  if (!clientPath) throw new Error("Server resolution specs require LUMINE_TEST_CLIENT_PATH.");
  const { createServerResolver } = require(path.join(clientPath, "lib", "server-resolver"));
  return {
    rootPath: process.cwd(),
    ...context,
    resolver: context.resolver || {
      ...createServerResolver({ environment: context.environment || process.env }),
    },
  };
}

function findOnPath(name, env = process.env) {
  return (
    resolutionContext().resolver.findExecutables(name, {
      env,
      allowShellWrapper: name === "roslyn-language-server",
    })[0] || null
  );
}

module.exports = { resolutionContext, findOnPath };
