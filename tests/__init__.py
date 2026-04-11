"""OctoClaw test package marker with stable runtime bootstrapping."""

from __future__ import annotations

import os
import sys
from pathlib import Path


LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from node_runtime import ensure_node_environment


os.environ.update(ensure_node_environment())
