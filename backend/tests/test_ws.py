import os
import sys
from fastapi.testclient import TestClient

# Ensure project root (backend/) is on sys.path so `app` package is importable when
# pytest is run from the backend directory or other working directories.
HERE = os.path.dirname(os.path.dirname(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from app.main import app


def test_ws_stream_basic():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        data = ws.receive_json()
        assert isinstance(data, dict)
        # basic expected keys
        assert "gpu_index" in data
        assert "gpu_util" in data
        assert 0 <= data["gpu_util"] <= 100
        assert "mem_util" in data
        assert "temperature" in data
        assert "fan_speed" in data
