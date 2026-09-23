# Cross-platform development and validation

The project uses several validation layers instead of trying to make one machine emulate every production environment.

## Validation layers

| Layer | What it validates | What it does not replace |
| --- | --- | --- |
| Local macOS checkout | fast edits, browser work, macOS sensor integration | Linux/Windows behavior or GitHub OIDC |
| Persistent Linux workstation/VM | clean Linux clone, pinned Python/Node toolchains, scientific Python stack, filesystem/permission behavior | Windows, macOS LaunchAgent, GitHub-hosted identity/deployment |
| GitHub cross-platform matrix | clean native Ubuntu/macOS/Windows portable checks | heavyweight weather rendering and local hardware |
| Production Pages workflow | full Ubuntu render pipeline, external data access, R2 OIDC upload, storage guards and Pages deployment | native Windows/macOS hardware behavior |
| Future physical Windows/Linux hosts | native host, recovery and hardware-specific validation | canonical public CI/deployment |

The persistent Linux workstation is therefore a **preflight/integration host**, not the production authority. GitHub Actions remains the clean-room reference because every run starts from a declared environment and production OIDC credentials exist only there.

## One portable test command

`scripts/verify.py` contains no shell-specific orchestration. It can be invoked from macOS, Linux or Windows:

```text
python scripts/verify.py --profile portable
```

Portable checks include:

- local Markdown links;
- `git diff --check`;
- syntax parsing of all tracked Python files;
- SYNOP Python regression tests;
- frontend JavaScript syntax;
- SYNOP JavaScript tests;
- Worker tests, including D1/R2 gateway behavior.

Python 3.13 and Node.js 24 are the reference toolchain versions.

## Linux workstation with uv

Use a clone on a native Linux filesystem such as ext4 rather than a VirtualBox/shared host folder when validating permissions, symlinks and filesystem behavior.

With `uv` and Node 24 available in `PATH`:

```bash
git clone https://github.com/oliwertwister/read-sensor.git
cd read-sensor

uv run --python 3.13 python scripts/verify.py --profile portable

uv run --python 3.13 \
  --with-requirements model/requirements.txt \
  python scripts/verify.py --profile integration
```

The integration profile exercises the installed scientific stack with MetPy diagnostics plus satellite fallback/history tests. It does not contact DWD/EUMETSAT or deploy anything.

For repeated use, keep the clone and `uv` cache on persistent Linux storage. Refresh the clone from `origin/main` before validation rather than testing an old shared working tree.

## GitHub cross-platform matrix

`.github/workflows/cross-platform.yml` runs the portable profile on:

- `ubuntu-latest`;
- `macos-latest`;
- `windows-latest`.

It is intentionally lightweight: no GRIB/FCI downloads, no R2 uploads and no Pages deployment. Its purpose is native OS/path/process compatibility.

The full `pages.yml` workflow remains Ubuntu-only because it is the production data/render/deploy pipeline.

## Platform-specific boundaries

The sensor collector deployment is currently **macOS-specific**:

- `osx-cpu-temp`;
- `launchctl`;
- LaunchAgent plist;
- `install-schedule.sh`.

Those pieces should not be presented as a generic project bootstrap.

The Linux workstation cannot validate:

- macOS LaunchAgent or `osx-cpu-temp`;
- native Windows PowerShell/path/ACL behavior;
- GitHub-hosted OIDC claims or Pages deployment identity;
- physical-device drivers or bare-metal recovery;
- nested hardware virtualization when the VM host does not expose it.

GitHub-hosted runners cannot validate the real sensor hardware or persistent workstation state.

## Future Windows/Linux machine

When a separate machine is available, keep the same layered model:

1. run `scripts/verify.py --profile portable` natively on Windows and Linux;
2. run the scientific integration profile on Linux and, if dependency wheels support it, on Windows;
3. add hardware/recovery checks specific to that machine outside the portable suite;
4. keep GitHub-hosted CI as the canonical clean-room check;
5. keep production OIDC/deployment in GitHub Actions.

A public repository should not expose an unrestricted self-hosted runner to untrusted pull-request code. If a future physical host is attached to GitHub Actions, restrict it to trusted/manual workflows and explicit labels.
