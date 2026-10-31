{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.openchamber;
  jsonFormat = pkgs.formats.json { };

  openchamberPackage = pkgs.callPackage ../packages/openchamber-web.nix { };
  settingsRegistry = builtins.fromJSON (
    builtins.readFile ../../packages/web/server/lib/opencode/settings-registry.json
  );
  settingsSurfaces = [
    "web"
    "desktop"
    "vscode"
    "mobile"
  ];
  surfaceSettings = lib.filterAttrs (_: settings: settings != { }) cfg.settingsBySurface;
  settingsEnabled = cfg.settings != { } || surfaceSettings != { } || cfg.sttApiKeyFile != null;
  desiredSettingsFile = jsonFormat.generate "openchamber-managed-settings.json" cfg.settings;
  desiredSurfaceSettingsFile = jsonFormat.generate "openchamber-managed-surface-settings.json" surfaceSettings;

  isLoopbackHost =
    host:
    builtins.elem host [
      "127.0.0.1"
      "localhost"
      "::1"
      "[::1]"
    ];

  opencodeManaged = cfg.opencode.enable && cfg.opencode.externalUrl == null;
  opencodeBinary =
    if cfg.opencode.binary != null then cfg.opencode.binary else lib.getExe cfg.opencode.package;
  opencodeUrl =
    if cfg.opencode.externalUrl != null then
      cfg.opencode.externalUrl
    else
      "http://${cfg.opencode.host}:${toString cfg.opencode.port}";

  commonEnvironment = {
    HOME = cfg.stateDir;
    XDG_CONFIG_HOME = "${cfg.stateDir}/.config";
    XDG_DATA_HOME = "${cfg.stateDir}/.local/share";
    XDG_STATE_HOME = "${cfg.stateDir}/.local/state";
    OPENCHAMBER_DATA_DIR = "${cfg.stateDir}/.config/openchamber";
    OPENCODE_CONFIG_DIR = "${cfg.stateDir}/.config/opencode";
    OPENCODE_BINARY = opencodeBinary;
    SHELL = "${pkgs.bashInteractive}/bin/bash";
  };

  runtimePackages = [
    pkgs.bashInteractive
    pkgs.bun
    pkgs.git
    pkgs.less
    pkgs.nodejs_22
    pkgs.openssh
    pkgs.python3
  ]
  ++ cfg.extraPackages;

  startScript = pkgs.writeShellScript "openchamber-start" ''
    set -eu

    if [ -n "''${CREDENTIALS_DIRECTORY:-}" ] && [ -f "$CREDENTIALS_DIRECTORY/ui-password" ]; then
      IFS= read -r OPENCHAMBER_UI_PASSWORD < "$CREDENTIALS_DIRECTORY/ui-password" || true
      export OPENCHAMBER_UI_PASSWORD
    fi

    exec ${lib.getExe cfg.package} serve --foreground \
      --port ${toString cfg.port} \
      --host ${lib.escapeShellArg cfg.host} \
      ${lib.optionalString cfg.apiOnly "--api-only"}
  '';

  opencodeStartScript = pkgs.writeShellScript "openchamber-opencode-start" ''
    set -eu

    exec ${lib.escapeShellArg opencodeBinary} serve \
      --hostname ${lib.escapeShellArg cfg.opencode.host} \
      --port ${toString cfg.opencode.port}
  '';

  reconcileHost =
    if
      builtins.elem cfg.host [
        "0.0.0.0"
        "::"
        "[::]"
      ]
    then
      "127.0.0.1"
    else if lib.hasInfix ":" cfg.host && !(lib.hasPrefix "[" cfg.host) then
      "[${cfg.host}]"
    else
      cfg.host;

  openchamberEnvironment =
    commonEnvironment
    // {
      OPENCODE_HOST = opencodeUrl;
      OPENCODE_SKIP_START = "true";
    }
    // cfg.extraEnvironment;
in
{
  options.services.openchamber = {
    enable = lib.mkEnableOption "OpenChamber web service";

    package = lib.mkOption {
      type = lib.types.package;
      default = openchamberPackage;
      defaultText = lib.literalExpression "pkgs.callPackage ../packages/openchamber-web.nix { }";
      description = "OpenChamber web package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "openchamber";
      description = "User that runs OpenChamber and the managed OpenCode service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "openchamber";
      description = "Group that owns OpenChamber state.";
    };

    createUser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to create the configured OpenChamber user and group.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/openchamber";
      description = "Persistent state directory used as HOME for OpenChamber.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address OpenChamber binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "TCP port OpenChamber listens on.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the OpenChamber port in the NixOS firewall.";
    };

    apiOnly = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Run OpenChamber in API-only mode without serving browser UI assets.";
    };

    passwordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/openchamber-ui-password";
      description = "Path to a one-line plaintext UI password file loaded through systemd credentials.";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf jsonFormat.type;
      default = { };
      example = {
        notificationMode = "always";
        themeVariant = "dark";
      };
      description = ''
        OpenChamber settings to enforce through the settings API. OpenChamber
        owns fields that are not present in this attribute set. Values are
        written to the Nix store and must not contain secrets.
        Saved per-client preferences take precedence over common values;
        use settingsBySurface to manage those preferences explicitly.
      '';
    };

    settingsBySurface = lib.mkOption {
      type = lib.types.submodule {
        options = lib.genAttrs settingsSurfaces (
          surface:
          lib.mkOption {
            type = lib.types.attrsOf jsonFormat.type;
            default = { };
            description = "Per-client OpenChamber preferences to enforce for ${surface}.";
          }
        );
      };
      default = { };
      example.mobile = {
        sidebarGrouping = "project";
        sidebarKeepWorkInPlace = true;
        sidebarDetailedZoneRows = true;
      };
      description = ''
        Preferences to enforce separately for web, desktop, vscode, or mobile
        clients. Only settings marked perSurface by OpenChamber are accepted.
        The mobile app and hosted mobile website share the mobile profile.
        Unlisted settings and profiles remain unmanaged. Removing a value stops
        management but leaves its saved value in place. Values enter the Nix
        store and must not contain secrets.
      '';
    };

    settingsReconciliation.interval = lib.mkOption {
      type = lib.types.nullOr lib.types.nonEmptyStr;
      default = null;
      example = "2d";
      description = ''
        How often to reconcile settings, settingsBySurface, and sttApiKeyFile.
        All are reconciled once during system startup. Set this to null to
        disable later runs.
      '';
    };

    sttApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/openchamber-stt-api-key";
      description = ''
        Path to a one-line transcription API key file. The settings reconciliation
        service loads it through systemd credentials and saves it through
        OpenChamber's voice-key API at startup and on each reconciliation run.
        Keep the file outside the Nix store. This replaces the saved transcription
        key but leaves other voice keys unchanged. Signed-in users can still
        change the key and transcription URL between reconciliation runs.
      '';
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/run/secrets/openchamber.env" ];
      description = "Additional systemd EnvironmentFile entries for OpenChamber.";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for the OpenChamber service.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional packages exposed on PATH to OpenChamber terminals and subprocesses.";
    };

    opencode = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to run a dedicated localhost OpenCode service for OpenChamber.";
      };

      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.opencode;
        defaultText = lib.literalExpression "pkgs.opencode";
        description = "OpenCode package used by the managed OpenCode service.";
      };

      binary = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/opt/opencode/bin/opencode";
        description = "Explicit OpenCode binary path. Overrides services.openchamber.opencode.package.";
      };

      externalUrl = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "http://127.0.0.1:4095";
        description = "Existing OpenCode server URL. When set, the managed OpenCode service is disabled.";
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Address for the managed OpenCode service.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 4095;
        description = "TCP port for the managed OpenCode service.";
      };

      environmentFiles = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Additional systemd EnvironmentFile entries for the managed OpenCode service.";
      };

      extraEnvironment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Additional environment variables for the managed OpenCode service.";
      };

      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Additional packages exposed on PATH to the managed OpenCode service.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.mapAttrsToList (surface: settings: {
      assertion = lib.all (
        key:
        (settingsRegistry.fields.${key}.perSurface or false)
        && builtins.elem surface (settingsRegistry.fields.${key}.surfaces or settingsSurfaces)
      ) (builtins.attrNames settings);
      message = "services.openchamber.settingsBySurface.${surface} accepts only supported perSurface preferences; put shared settings in services.openchamber.settings.";
    }) surfaceSettings;

    warnings = lib.optional (!isLoopbackHost cfg.host && cfg.passwordFile == null) (
      "services.openchamber binds to ${cfg.host} without services.openchamber.passwordFile; "
      + "the browser UI will be exposed without password protection."
    );

    users.groups = lib.mkIf cfg.createUser {
      ${cfg.group} = { };
    };

    users.users = lib.mkIf cfg.createUser {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.stateDir;
        createHome = true;
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.config 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.config/openchamber 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.config/opencode 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.local 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.local/share 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.local/share/opencode 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.local/state 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.local/state/opencode 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/.ssh 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/workspaces 0750 ${cfg.user} ${cfg.group} -"
    ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.openchamber-opencode = lib.mkIf opencodeManaged {
      description = "OpenCode server for OpenChamber";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      path = runtimePackages ++ cfg.opencode.extraPackages;
      environment = commonEnvironment // cfg.opencode.extraEnvironment;

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "${cfg.stateDir}/workspaces";
        ExecStart = opencodeStartScript;
        EnvironmentFile = cfg.opencode.environmentFiles;
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.openchamber = {
      description = "OpenChamber web server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ] ++ lib.optional opencodeManaged "openchamber-opencode.service";
      wants = [ "network-online.target" ];
      requires = lib.optional opencodeManaged "openchamber-opencode.service";

      path = runtimePackages;
      environment = openchamberEnvironment;

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "${cfg.stateDir}/workspaces";
        ExecStart = startScript;
        EnvironmentFile = cfg.environmentFiles;
        LoadCredential = lib.optional (cfg.passwordFile != null) "ui-password:${cfg.passwordFile}";
        Restart = if settingsEnabled then "always" else "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.openchamber-settings-reconcile = lib.mkIf settingsEnabled {
      description = "Reconcile declarative OpenChamber settings";
      wantedBy = [ "multi-user.target" ];
      after = [ "openchamber.service" ];
      wants = [ "openchamber.service" ];
      environment = {
        OPENCHAMBER_RECONCILE_BASE_URL = "http://${reconcileHost}:${toString cfg.port}";
        OPENCHAMBER_RECONCILE_DESIRED_SETTINGS_FILE = desiredSettingsFile;
        OPENCHAMBER_RECONCILE_DESIRED_SURFACE_SETTINGS_FILE = desiredSurfaceSettingsFile;
        OPENCHAMBER_RECONCILE_SETTINGS_FILE = "${openchamberEnvironment.OPENCHAMBER_DATA_DIR}/settings.json";
        OPENCHAMBER_RECONCILE_STT_API_KEY = lib.boolToString (cfg.sttApiKeyFile != null);
      };
      serviceConfig = {
        Type = "oneshot";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.stateDir;
        ExecStart = "${pkgs.nodejs_22}/bin/node ${./openchamber-settings-reconcile.mjs}";
        LoadCredential =
          lib.optional (cfg.passwordFile != null) "ui-password:${cfg.passwordFile}"
          ++ lib.optional (cfg.sttApiKeyFile != null) "stt-api-key:${cfg.sttApiKeyFile}";
      };
    };

    systemd.timers.openchamber-settings-reconcile =
      lib.mkIf (settingsEnabled && cfg.settingsReconciliation.interval != null)
        {
          description = "Reconcile declarative OpenChamber settings periodically";
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnBootSec = cfg.settingsReconciliation.interval;
            OnUnitActiveSec = cfg.settingsReconciliation.interval;
            Unit = "openchamber-settings-reconcile.service";
          };
        };
  };
}
