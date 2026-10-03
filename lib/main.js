const server = require("./server");
const setting = (name) => lumine.config.get(`ide-csharp.${name}`);

module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "ide-csharp",
      displayName: "Roslyn",
      grammarScopes: ["source.cs"],
      languageId: "csharp",
      sessionScope: "project-root",
      restartKeyPaths: ["ide-csharp.serverPath", "ide-csharp.dotnetPath"],
      settingsKeyPaths: ["ide-csharp"],
      // References lenses require Roslyn's peekReferences client command.
      isFeatureAvailable: (feature) => feature !== "codeLens",
      getSettings: () => ({}),
      getWorkspaceConfiguration(section) {
        const options = {
          "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters": "parameterHints",
          "csharp|inlay_hints.csharp_enable_inlay_hints_for_types": "typeHints",
        };
        const name = options[section];
        if (!name) return undefined;
        const value = setting(name);
        return value === "enabled" ? true : value === "disabled" ? false : undefined;
      },
      managedServerDisplayName: "Roslyn language server",
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      async resolveServer(context) {
        const launch = await server.resolveServer(
          setting("serverPath"),
          context.managedServer,
          setting("dotnetPath"),
        );
        if (!launch) {
          client.reportMissingServer("ide-csharp", {
            description:
              "Install Roslyn through Manage Servers and a .NET 10 SDK, or install the roslyn-language-server .NET tool and put it on PATH. Keep the SDKs required by your projects available.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-csharp",
      tips: [
        "C# projects get completion, navigation and refactorings from Roslyn. Open the folder containing your solution or project and install the .NET SDK it requires.",
      ],
    };
  },
};
