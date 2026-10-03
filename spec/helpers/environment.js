const { findOnPath } = require("../../lib/server");
const serverPath = process.env.CSHARP_SERVER_PATH || findOnPath("roslyn-language-server");
const dotnetPath = process.env.CSHARP_DOTNET_PATH || findOnPath("dotnet");
if (process.env.REQUIRE_ROSLYN && (!serverPath || !dotnetPath))
  throw new Error("CI requires a real Roslyn language server and a .NET 10 SDK.");
module.exports = {
  serverPath,
  dotnetPath,
  liveSuite: serverPath && dotnetPath ? describe : () => {},
};
