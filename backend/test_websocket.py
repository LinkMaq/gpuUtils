import asyncio
import websockets
import json

async def test_websocket():
    uri = "ws://localhost:8000/ws"
    async with websockets.connect(uri) as websocket:
        print("Connected to", uri)
        try:
            # 接收5次数据
            for i in range(5):
                response = await websocket.recv()
                data = json.loads(response)
                print(f"\n=== 数据更新 #{i+1} ===")
                print(f"时间戳: {data['timestamp']}")
                for gpu in data['gpus']:
                    print(f"\nGPU {gpu['gpu_index']} ({gpu['name']}):")
                    print(f"  GPU利用率: {gpu['gpu_util']}%")
                    print(f"  显存使用率: {gpu['mem_util']}%")
                    print(f"  显存: {gpu['memory']['used']}MB / {gpu['memory']['total']}MB")
                    print(f"  温度: {gpu['temperature']}°C")
                    print(f"  风扇转速: {gpu['fan_speed']}%")
                    print(f"  功率: {gpu['power']}W")
                    print(f"  性能状态: {gpu['performance_state']}")
                    print(f"  时钟频率:")
                    print(f"    - 核心: {gpu['clocks']['graphics']}MHz")
                    print(f"    - 显存: {gpu['clocks']['memory']}MHz")
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            print("\n用户中断，停止测试")

if __name__ == "__main__":
    print("开始测试 WebSocket GPU 数据流...")
    print("将显示5次数据更新，每次间隔1秒")
    print("确保后端服务已在运行 (uvicorn app.main:app --reload --host 0.0.0.0 --port 8000)")
    print("-" * 80)
    asyncio.run(test_websocket())