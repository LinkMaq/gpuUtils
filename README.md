# gpuUtils (minimal prototype)

这是一个最小可运行的项目原型，用于演示后端通过 WebSocket 推送 GPU 指标，前端使用 React + Vite 监听并展示这些指标。

目录结构（重要部分）：

- `backend/` - FastAPI 后端
  - `app/main.py` - WebSocket 服务（mock 数据）
  - `requirements.txt` - Python 依赖
  - `tests/` - 单元测试

- `frontend/` - Vite + React 前端
  - `package.json` 和 `src/`

快速运行说明（macOS, zsh）

后端：

```bash
# 进入后端目录
cd backend
# 可选：创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# 启动服务
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

前端：

```bash
cd frontend
# 安装依赖
npm install
# 启动开发服务器（Vite）
npm run dev
# 前端在启动后会尝试连接到 ws://localhost:8000/ws

使用 Docker / docker-compose（可选）

你也可以用 Docker 一键启动后端和前端（在本地无需安装 Python 依赖或 Node）：

```bash
# 在仓库根目录运行
docker-compose build
docker-compose up
```

注意：前端镜像使用 `vite preview` 在 5173 端口提供已构建的静态文件；后端在 8000 端口运行 FastAPI（WebSocket `/ws`）。
```

测试（后端）：

```bash
cd backend
# 在虚拟环境中
pip install -r requirements.txt
pytest -q
```

说明

- 该版本使用模拟数据（random）。在后续迭代中，可替换为真实的 exporter（如 DCGM、nvidia-smi 或自定义收集器）。
- 如果你需要我把项目部署到 Docker / k8s，或加入真实的 GPU exporter 适配器，我可以继续实现。