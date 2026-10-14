#!/usr/bin/env python3
"""Emit runtime-manifest.json for the curated Python runtime (DESIGN §6.5). Standard library only.

    pip list --format json | python3 emit-manifest.py [--image IMAGE] [--python X.Y] [--runtime NAME]

Reads pip's JSON on stdin, keeps the curated distributions, and prints the manifest in the shape of
tests/runtime-manifest.python-1.json plus a "distributions" map of resolved versions. Exits 1 if any curated
distribution is missing: the image must contain all of them or the scanner's allow-list would lie.
"""
import argparse
import json
import sys

# distribution name on PyPI -> top-level import name the scanner allows (contracts: the manifest "modules" list)
CURATED = {
    "streamlit": "streamlit",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "pandas": "pandas",
    "numpy": "numpy",
    "plotly": "plotly",
    "altair": "altair",
    "pydantic": "pydantic",
    "starlette": "starlette",
}

# identical to deploy/python-artifact/render.sh and tests/runtime-manifest.python-1.json
ENTRYPOINTS = {
    "streamlit": [
        "streamlit", "run", "/app/app.py",
        "--server.port=8080", "--server.address=0.0.0.0",
        "--server.headless=true", "--browser.gatherUsageStats=false",
    ],
    "fastapi": [
        "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app",
    ],
}


def normalize(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def build(pip_list, image: str, python: str, runtime: str) -> dict:
    installed = {normalize(p["name"]): p["version"] for p in pip_list}
    missing = [d for d in CURATED if d not in installed]
    if missing:
        raise SystemExit(f"emit-manifest: curated distributions missing from the image: {', '.join(missing)}")
    return {
        "runtime": runtime,
        "image": image,
        "python": python,
        "entrypoints": ENTRYPOINTS,
        "modules": [CURATED[d] for d in CURATED],
        "distributions": {d: installed[d] for d in CURATED},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", default="jfrog.corp.com/artifacts/python-runtime")
    ap.add_argument("--python", default=f"{sys.version_info.major}.{sys.version_info.minor}",
                    help="python major.minor; defaults to the interpreter running this script")
    ap.add_argument("--runtime", default="python-1")
    args = ap.parse_args()
    try:
        pip_list = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        raise SystemExit(f"emit-manifest: stdin is not pip list --format json: {e}")
    if not isinstance(pip_list, list):
        raise SystemExit("emit-manifest: expected a JSON array from pip list --format json")
    json.dump(build(pip_list, args.image, args.python, args.runtime), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
