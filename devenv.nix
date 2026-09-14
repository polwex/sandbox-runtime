{
  pkgs,
  lib,
  config,
  inputs,
  ...
}: {
  # https://devenv.sh/basics/
  env.GREET = "devenv";
  # `bun run build:seccomp` links `gcc -static -lseccomp`, which needs a static
  # archive; nixpkgs' `libseccomp` ships only libseccomp.so. `packages` puts
  # nothing on the linker search path, and the plain package's default output
  # has no archive either — the .a is in the `lib` output that makeLibraryPath
  # resolves to.
  env.LIBRARY_PATH = lib.makeLibraryPath [pkgs.pkgsStatic.libseccomp];

  # https://devenv.sh/packages/
  packages = with pkgs; [
    git
    gcc
    binutils
    libseccomp
    glibc.static # build:seccomp
    python3 # pid-namespace tests
    bubblewrap
    socat
    ripgrep # the sandbox itself
    netcat-openbsd
    curl
    coreutils
    procps
    jdk
    zsh # optional: un-skip two suites
  ];

  # https://devenv.sh/languages/
  languages = {
    javascript = {
      enable = true;
      npm.enable = true;
      bun.enable = true;
    };
    python.enable = true;
  };

  # https://devenv.sh/processes/
  # processes.dev.exec = "${lib.getExe pkgs.watchexec} -n -- ls -la";

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  # https://devenv.sh/scripts/
  scripts.hello.exec = ''
    echo hello from $GREET
  '';

  # https://devenv.sh/basics/
  enterShell = ''
    hello         # Run scripts directly
    git --version # Use packages
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    git --version | grep --color=auto "${pkgs.git.version}"
  '';

  # https://devenv.sh/git-hooks/
  # git-hooks.hooks.shellcheck.enable = true;

  # See full reference at https://devenv.sh/reference/options/
  #

  outputs = {
    default = pkgs.callPackage ./package.nix {};
  };
}
