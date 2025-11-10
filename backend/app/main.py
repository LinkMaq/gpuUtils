import asyncio
import json
import random
import time
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="gpuUtils - mock backend")


def make_mock_metrics(gpu_index: int = 0) -> Dict:
    now = time.time()
    return {
        "timestamp": now,
        "gpu_index": gpu_index,
        "gpu_util": round(random.uniform(0, 100), 2),
        "mem_util": round(random.uniform(0, 100), 2),
        "temperature": round(random.uniform(30, 85), 1),
        "fan_speed": round(random.uniform(0, 100), 1),
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    gpu_index = 0
    try:
        # simple loop sending mocked metrics until client disconnects
        while True:
            metrics = make_mock_metrics(gpu_index=gpu_index)
            await websocket.send_json(metrics)
            # wait a bit - realistic deployments will have configurable rate
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        # client disconnected
        return
    except Exception:
        # best-effort: close websocket on unexpected errors
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
