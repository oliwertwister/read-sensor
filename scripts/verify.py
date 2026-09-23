#!/usr/bin/env python3
"""Cross-platform local validation for read-sensor.

This runner deliberately avoids shell syntax so the same command can be used on
macOS, Linux and Windows. Networked rendering/deployment remains outside this
script and is covered by the production GitHub Actions workflow.
"""

from __future__ import annotations

import argparse
import ast
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PYTHON_TESTS = (
    "synop/test_update_synop.py",
    "synop/test_update_live.py",
)

INTEGRATION_TESTS = (
    "model/test_metpy_diagnostics.py",
    "satellite/test_render_satellite.py",
    "satellite/test_history.py",
)

JAVASCRIPT_CHECKS = (
    "app.js",
    "model-map.js",
    "cube-storage.js",
    "cube-reader-worker.js",
    "data-monitor.js",
    "config.js",
    "geometry-loader.js",
    "geometry-ui.js",
    "synop.js",
    "rar-worker.js",
)


def command_label(command: list[str]) -> str:
    return " ".join(command)


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"\n> {command_label(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def tracked_python_files() -> list[Path]:
    output = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "*.py"],
        text=True,
    )
    return [ROOT / line for line in output.splitlines() if line]


def check_python_syntax() -> None:
    files = tracked_python_files()
    for path in files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    print(f"python syntax: OK ({len(files)} tracked files)")


def python_test_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, [str(ROOT), str(ROOT / "satellite"), env.get("PYTHONPATH", "")])
    )
    return env


def portable_checks(*, require_node: bool) -> None:
    run([sys.executable, "scripts/check_docs.py"])
    run(["git", "diff", "--check"])
    check_python_syntax()

    env = python_test_env()
    for test in PYTHON_TESTS:
        run([sys.executable, test], env=env)

    node = shutil.which("node")
    if not node:
        if require_node:
            raise RuntimeError("Node.js is required for portable checks")
        print("Node.js not found; JavaScript checks skipped.")
        return

    for source in JAVASCRIPT_CHECKS:
        run([node, "--check", source])
    run([node, "synop/test_decode.js"])
    run([node, "--test", "worker/test/index.test.js"])


def integration_checks() -> None:
    env = python_test_env()
    for test in INTEGRATION_TESTS:
        run([sys.executable, test], env=env)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--profile",
        choices=("portable", "integration", "all"),
        default="portable",
        help="portable = no third-party Python deps; integration = installed scientific deps",
    )
    parser.add_argument(
        "--allow-missing-node",
        action="store_true",
        help="do not fail portable checks when Node.js is unavailable",
    )
    args = parser.parse_args()

    if args.profile in {"portable", "all"}:
        portable_checks(require_node=not args.allow_missing_node)
    if args.profile in {"integration", "all"}:
        integration_checks()

    print(f"\nverification profile '{args.profile}': OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
