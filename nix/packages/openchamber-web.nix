{
  lib,
  stdenv,
  stdenvNoCC,
  bun,
  cacert,
  git,
  less,
  makeWrapper,
  nodejs_22,
  openssh,
  python3,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ../../package.json);

  src = lib.cleanSourceWith {
    src = ../..;
    filter =
      path: type:
      let
        root = toString ../..;
        rel = lib.removePrefix "${root}/" (toString path);
        base = baseNameOf path;
      in
      !(
        base == ".git"
        || base == "node_modules"
        || base == "data"
        || base == "result"
        || lib.hasSuffix "/node_modules" rel
        || lib.hasPrefix "data/" rel
        || lib.hasPrefix "result/" rel
        || lib.hasPrefix "packages/electron/dist" rel
        || lib.hasPrefix "packages/vscode/dist" rel
      );
  };

  bunDeps = stdenvNoCC.mkDerivation {
    pname = "openchamber-bun-deps";
    inherit (packageJson) version;

    inherit src;

    nativeBuildInputs = [
      bun
      cacert
      git
      nodejs_22
    ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild

      export HOME="$TMPDIR/home"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      export SSL_CERT_FILE="${cacert}/etc/ssl/certs/ca-bundle.crt"
      export GIT_SSL_CAINFO="$SSL_CERT_FILE"
      mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR"

      bun install --frozen-lockfile --ignore-scripts

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out"
      cp -R node_modules "$out/node_modules"

      for workspace in packages/*; do
        [ -f "$workspace/package.json" ] || continue
        mkdir -p "$out/$workspace"
        cp "$workspace/package.json" "$out/$workspace/package.json"
      done

      for workspace in ui web; do
        if [ -d "packages/$workspace/node_modules" ]; then
          cp -R "packages/$workspace/node_modules" "$out/packages/$workspace/node_modules"
        fi
      done

      runHook postInstall
    '';

    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-KSjL5c8vhqEg/3YnHpggXxk5QztCLiPlNkMgocc/FjQ=";
  };

  runtimePath = lib.makeBinPath [
    bun
    git
    less
    nodejs_22
    openssh
    python3
  ];
in
stdenv.mkDerivation {
  pname = "openchamber-web";
  inherit (packageJson) version;

  inherit src;

  nativeBuildInputs = [
    bun
    makeWrapper
    nodejs_22
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    cp -R ${bunDeps}/node_modules node_modules
    chmod -R u+w node_modules

    if [ -d ${bunDeps}/packages/web/node_modules ]; then
      cp -R ${bunDeps}/packages/web/node_modules packages/web/node_modules
      chmod -R u+w packages/web/node_modules
    fi
    if [ -d ${bunDeps}/packages/ui/node_modules ]; then
      cp -R ${bunDeps}/packages/ui/node_modules packages/ui/node_modules
      chmod -R u+w packages/ui/node_modules
    fi

    patchShebangs node_modules
    if [ -d packages/web/node_modules ]; then
      patchShebangs packages/web/node_modules
    fi
    if [ -d packages/ui/node_modules ]; then
      patchShebangs packages/ui/node_modules
    fi

    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"

    bun run build:web

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    appDir="$out/share/openchamber"
    mkdir -p "$appDir/packages/web" "$out/bin"

    cp package.json "$appDir/package.json"
    cp -R node_modules "$appDir/node_modules"

    for workspace in ui electron vscode; do
      mkdir -p "$appDir/packages/$workspace"
      cp "packages/$workspace/package.json" "$appDir/packages/$workspace/package.json"
    done

    cp packages/web/package.json "$appDir/packages/web/package.json"
    cp -R packages/web/bin "$appDir/packages/web/bin"
    cp -R packages/web/server "$appDir/packages/web/server"
    cp -R packages/web/dist "$appDir/packages/web/dist"

    if [ -d packages/web/node_modules ]; then
      cp -R packages/web/node_modules "$appDir/packages/web/node_modules"
    fi

    makeWrapper ${bun}/bin/bun "$out/bin/openchamber" \
      --set NODE_ENV production \
      --set OPENCHAMBER_DIST_DIR "$appDir/packages/web/dist" \
      --set BUN_BINARY ${bun}/bin/bun \
      --prefix PATH : ${lib.escapeShellArg runtimePath} \
      --add-flags "$appDir/packages/web/bin/cli.js"

    runHook postInstall
  '';

  meta = {
    description = packageJson.description or "OpenChamber web runtime";
    homepage = "https://github.com/btriapitsyn/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber";
    platforms = lib.platforms.unix;
  };
}
