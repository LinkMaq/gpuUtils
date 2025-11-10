## 项目背景
gpuUtils是一个云原生的 GPU 实时数据展示平台，用于在 kubernetes集群中实时展示 GPU 设备的使用率。

## 核心价值
1. 可视化 GPU 设备的使用数据
2. 实时(毫秒级)输出Nvidia显卡数据

## 系统架构

```
监控前台
       ↓
    gpuUtil API (websockets)
       ↓
    gpuUtils Service
       ↓
    GPU显卡 exporter（如英伟达 dcgm，Ascend NPU）

```

采用前后端一体的，前端使用 React 框架，后端使用python语言编写 API 服务。前端风格采用 Meteria Design 组件库。

## 功能特性
- 实时监控 GPU 使用率、显存使用率、温度等数据
- 支持多种 GPU 设备（如 NVIDIA,Ascend）
- 支持多种数据展示方式（如折线图、柱状图等）
- 采用 daemonSet 部署在 kubernetes 集群中，方便扩展和管理
