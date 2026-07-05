{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.openchamber;

  openchamberPackage = pkgs.callPackage ../packages/openchamber-web.nix { };

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
      environment =
        commonEnvironment
        // {
          OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = "true";
          OPENCODE_HOST = opencodeUrl;
          OPENCODE_SKIP_START = "true";
        }
        // cfg.extraEnvironment;

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "${cfg.stateDir}/workspaces";
        ExecStart = startScript;
        EnvironmentFile = cfg.environmentFiles;
        LoadCredential = lib.optional (cfg.passwordFile != null) "ui-password:${cfg.passwordFile}";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
