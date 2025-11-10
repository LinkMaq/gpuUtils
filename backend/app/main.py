import asyncio
import json
import random
import time
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="gpuUtils - mock backend")

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class GPUState:
    def __init__(self, index: int):
        self.index = index
        self.util = 0.0
        self.mem_util = 0.0
        self.temp = 35.0
        self.fan = 0.0
        self.power = 30.0
        self.memory_total = 16384  # MB
        self.memory_used = 0  # MB
        self.clocks = {"graphics": 300, "memory": 405, "sm": 300}
        # 新增网络/错误/PCIe指标
        self.nvlink_bandwidth = 0.0  # GB/s
        self.xid_errors = 0
        self.pcie_tx = 0.0  # GB/s
        self.pcie_rx = 0.0  # GB/s

    def update(self):
        # 模拟真实的GPU状态变化
        # GPU利用率变化
        target = random.choice([0, 30, 50, 80, 100])  # 模拟任务负载变化
        self.util = max(0, min(100, self.util + random.uniform(-10, 10) if abs(self.util - target) < 20 else (target - self.util) * 0.3))
        
        # 显存使用变化
        if random.random() < 0.1:  # 10%概率发生显存变化
            self.memory_used = max(0, min(self.memory_total, self.memory_used + random.randint(-1024, 1024)))
        self.mem_util = (self.memory_used / self.memory_total) * 100

        # 温度变化
        temp_impact = self.util * 0.5  # GPU使用率对温度的影响
        self.temp = max(30, min(85, self.temp + random.uniform(-0.5, 0.5) + (temp_impact - self.temp) * 0.1))
        
        # 风扇速度根据温度调整
        target_fan = max(0, (self.temp - 30) * 2)  # 30度以上开始调整风扇
        self.fan = max(0, min(100, self.fan + (target_fan - self.fan) * 0.2))
        
        # 功率变化
        base_power = 30  # 基础功耗
        load_power = self.util * 2  # 负载功耗
        self.power = base_power + load_power + random.uniform(-5, 5)

        # 时钟频率调整
        base_clock = 300
        boost = (self.util / 100) * 1500  # 最大boost 1800MHz
        self.clocks["graphics"] = int(base_clock + boost)
        self.clocks["memory"] = int(405 + (self.util / 100) * 400)  # 内存频率变化
        self.clocks["sm"] = self.clocks["graphics"]
        # 模拟 nvlink / pcie / xid 统计
        # nvlink 带宽根据利用率波动
        self.nvlink_bandwidth = max(0.0, min(600.0, (self.util / 100) * 600 + random.uniform(-20, 20)))
        # 随机产生 XID 错误（很小概率）
        if random.random() < 0.01:
            self.xid_errors += random.randint(1, 5)
        # PCIe 传输随负载波动
        self.pcie_tx = max(0.0, (self.util / 100) * 50 + random.uniform(-2, 2))
        self.pcie_rx = max(0.0, (self.util / 100) * 50 + random.uniform(-2, 2))

gpu_states = {i: GPUState(i) for i in range(4)}  # 模拟4个GPU

def make_mock_metrics(gpu_index: int = 0) -> Dict:
    now = time.time()
    gpu_state = gpu_states[gpu_index]
    gpu_state.update()
    
    return {
        "timestamp": now,
        "gpu_index": gpu_index,
        "name": f"NVIDIA A100-SXM4-80GB #{gpu_index}",
        "gpu_util": round(gpu_state.util, 2),
        "mem_util": round(gpu_state.mem_util, 2),
        "memory": {
            "total": gpu_state.memory_total,
            "used": round(gpu_state.memory_used, 2),
            "free": round(gpu_state.memory_total - gpu_state.memory_used, 2)
        },
        "temperature": round(gpu_state.temp, 1),
        "fan_speed": round(gpu_state.fan, 1),
        "power": round(gpu_state.power, 2),
        "clocks": gpu_state.clocks,
        "performance_state": "P0" if gpu_state.util > 50 else "P2"
    ,
        "nvlink_bandwidth": round(gpu_state.nvlink_bandwidth, 2),
        "xid_errors": gpu_state.xid_errors,
        "pcie_tx": round(gpu_state.pcie_tx, 2),
        "pcie_rx": round(gpu_state.pcie_rx, 2)
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        # simple loop sending mocked metrics for all GPUs until client disconnects
        while True:
            # 发送所有GPU的数据
            metrics_list = [make_mock_metrics(gpu_index=i) for i in range(4)]
            await websocket.send_json({
                "timestamp": time.time(),
                "gpus": metrics_list
            })
            # 每秒更新一次数据
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
