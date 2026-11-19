#!/usr/bin/env python3
"""manifest.json and version.json must carry the same version, or the update check misfires."""
import json, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
a = json.loads((root / "extension" / "manifest.json").read_text())["version"]
b = json.loads((root / "version.json").read_text())["version"]
print(("PASS" if a == b else "FAIL") + f" manifest {a} / version.json {b}")
sys.exit(0 if a == b else 1)
