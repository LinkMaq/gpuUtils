import asyncio
import json
import time
from typing import Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import dcgm_fields
import DcgmPython
import pynvml

app = FastAPI(title="gpuUtils - NVIDIA DCGM backend")

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DCGMManager:
    def __init__(self):
        # 初始化DCGM
        self.dcgm_handle = DcgmPython.DcgmHandle()
        self.dcgm_system = DcgmPython.DcgmSystem(self.dcgm_handle)
        self.dcgm_system.Init()

        # 初始化NVML
        pynvml.nvmlInit()
        
        # 获取所有GPU
        self.gpu_ids = self.dcgm_system.discovery.GetAllGpuIds()
        
        # 创建GPU组
        self.group_id = self.dcgm_system.group.CreateGroup("gpuUtilsGroup")
        for gpu_id in self.gpu_ids:
            self.dcgm_system.group.AddToGroup(self.group_id, gpu_id)

        # 配置要监控的字段
        self.fields = [
            dcgm_fields.DCGM_FI_DEV_GPU_UTIL,            # GPU利用率
            dcgm_fields.DCGM_FI_DEV_FB_USED,             # 显存使用量
            dcgm_fields.DCGM_FI_DEV_FB_FREE,             # 可用显存
            dcgm_fields.DCGM_FI_DEV_FB_TOTAL,            # 总显存
            dcgm_fields.DCGM_FI_DEV_GPU_TEMP,            # GPU温度
            dcgm_fields.DCGM_FI_DEV_POWER_USAGE,         # 功率使用
            dcgm_fields.DCGM_FI_DEV_SM_CLOCK,            # SM时钟
            dcgm_fields.DCGM_FI_DEV_MEM_CLOCK,           # 显存时钟
            dcgm_fields.DCGM_FI_DEV_FAN_SPEED,           # 风扇速度
            dcgm_fields.DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, # NVLink带宽
            dcgm_fields.DCGM_FI_DEV_PCIE_TX_THROUGHPUT,  # PCIe发送吞吐量
            dcgm_fields.DCGM_FI_DEV_PCIE_RX_THROUGHPUT,  # PCIe接收吞吐量
            dcgm_fields.DCGM_FI_DEV_XID_ERRORS           # XID错误
        ]
        
        # 配置监控参数
        self.dcgm_system.config.SetWatchFields(
            self.group_id,
            self.fields,
            update_freq=100000,  # 100ms更新频率
            max_keep_age=0,      # 不保留历史数据
            max_keep_samples=1    # 只保留最新样本
        )

    def get_gpu_info(self) -> List[Dict]:
        try:
            values = self.dcgm_system.status.GetLatestValues(self.group_id, self.fields)
            metrics = []

            for gpu_id in self.gpu_ids:
                handle = pynvml.nvmlDeviceGetHandleByIndex(gpu_id)
                gpu_name = pynvml.nvmlDeviceGetName(handle).decode('utf-8')
                gpu_info = values[gpu_id]
                
                metrics.append({
                    "timestamp": time.time(),
                    "gpu_index": gpu_id,
                    "name": gpu_name,
                    "gpu_util": gpu_info[dcgm_fields.DCGM_FI_DEV_GPU_UTIL].value,
                    "mem_util": (gpu_info[dcgm_fields.DCGM_FI_DEV_FB_USED].value / 
                                gpu_info[dcgm_fields.DCGM_FI_DEV_FB_TOTAL].value * 100),
                    "memory": {
                        "total": gpu_info[dcgm_fields.DCGM_FI_DEV_FB_TOTAL].value // (1024 * 1024),  # Convert to MB
                        "used": gpu_info[dcgm_fields.DCGM_FI_DEV_FB_USED].value // (1024 * 1024),
                        "free": gpu_info[dcgm_fields.DCGM_FI_DEV_FB_FREE].value // (1024 * 1024)
                    },
                    "temperature": gpu_info[dcgm_fields.DCGM_FI_DEV_GPU_TEMP].value,
                    "fan_speed": gpu_info[dcgm_fields.DCGM_FI_DEV_FAN_SPEED].value,
                    "power": gpu_info[dcgm_fields.DCGM_FI_DEV_POWER_USAGE].value / 1000.0,  # Convert to W
                    "clocks": {
                        "graphics": gpu_info[dcgm_fields.DCGM_FI_DEV_SM_CLOCK].value,
                        "memory": gpu_info[dcgm_fields.DCGM_FI_DEV_MEM_CLOCK].value,
                        "sm": gpu_info[dcgm_fields.DCGM_FI_DEV_SM_CLOCK].value
                    },
                    "nvlink_bandwidth": gpu_info[dcgm_fields.DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL].value / 1e9,  # Convert to GB/s
                    "xid_errors": gpu_info[dcgm_fields.DCGM_FI_DEV_XID_ERRORS].value,
                    "pcie_tx": gpu_info[dcgm_fields.DCGM_FI_DEV_PCIE_TX_THROUGHPUT].value / 1e9,  # Convert to GB/s
                    "pcie_rx": gpu_info[dcgm_fields.DCGM_FI_DEV_PCIE_RX_THROUGHPUT].value / 1e9   # Convert to GB/s
                })
            return metrics
        except Exception as e:
            print(f"Error getting GPU metrics: {e}")
            return []

    def __del__(self):
        try:
            self.dcgm_system.group.DestroyGroup(self.group_id)
            pynvml.nvmlShutdown()
        except:
            pass

# 初始化DCGM管理器
dcgm_manager = DCGMManager()

# 使用线程池执行GPU数据收集
executor = ThreadPoolExecutor(max_workers=1)

async def get_gpu_metrics() -> List[Dict]:
    # 在线程池中执行GPU数据收集
    return await asyncio.get_event_loop().run_in_executor(executor, dcgm_manager.get_gpu_info)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # 获取所有GPU的实时数据
            metrics_list = await get_gpu_metrics()
            if metrics_list:
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
