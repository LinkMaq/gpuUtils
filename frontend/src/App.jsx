import React, { useEffect, useState, useRef, useMemo } from "react";
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';

import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Chip from '@mui/material/Chip';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';

const getUtilColor = (util) => {
  if (util >= 90) return '#ef4444';
  if (util >= 70) return '#f97316';
  if (util >= 50) return '#eab308';
  return '#22c55e';
};

export default function App() {
  const [gpuData, setGpuData] = useState(null);
  const [history, setHistory] = useState({});
  const [chartDataMap, setChartDataMap] = useState({});
  const CHART_MAX = 120; // 保持最近120个数据点  
  const CHART_STEP_SEC = 1; // 固定时间步长(秒)
  const TOLERANCE_SEC = 0.5; // 数据采样容差(秒)
  const CHART_ANIMATION_DURATION = 300; // 图表动画持续时间(毫秒)
  const UPDATE_INTERVAL = 1000; // 图表更新间隔(毫秒)

  const [selectedSet, setSelectedSet] = useState(new Set());
  const selectedSetRef = useRef(selectedSet);
  const [connectionStatus, setConnectionStatus] = useState('idle'); // idle, connecting, open, closed, error
  const [lastError, setLastError] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const [rawMessage, setRawMessage] = useState(null);
  const [endpointCandidates] = useState(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return [
      `${proto}://${location.hostname}:8000/ws`,
      `${proto}://localhost:8000/ws`,
      `${proto}://127.0.0.1:8000/ws`
    ];
  });
  const [endpoint, setEndpoint] = useState(() => endpointCandidates[0]);
  const [manualEndpoint, setManualEndpoint] = useState('');
  const backoffRef = useRef({ attempt: 0, ms: 1000 });
  const [running, setRunning] = useState(false);
  const [podName, setPodName] = useState(() => `pod-${location.hostname}`);
  const metricsCatalog = [
    { key: 'gpu_util', label: 'GPU 使用率', unit: '%', accessor: d => d.gpu_util },
    { key: 'mem_util', label: '显存使用率', unit: '%', accessor: d => d.mem_util },
    { key: 'memory_used', label: '显存已用', unit: 'MB', accessor: d => d.memory?.used ?? 0 },
    { key: 'temperature', label: '温度', unit: '°C', accessor: d => d.temperature },
    { key: 'power', label: '功耗', unit: 'W', accessor: d => d.power },
    { key: 'nvlink_bandwidth', label: 'NvLink 带宽', unit: 'GB/s', accessor: d => d.nvlink_bandwidth },
    { key: 'pcie_tx', label: 'PCIe 发送', unit: 'GB/s', accessor: d => d.pcie_tx },
    { key: 'pcie_rx', label: 'PCIe 接收', unit: 'GB/s', accessor: d => d.pcie_rx },
    { key: 'xid_errors', label: 'XID 错误数', unit: 'count', accessor: d => d.xid_errors }
  ];
  const [selectedMetrics, setSelectedMetrics] = useState(new Set(['gpu_util']));
  const [activeMetric, setActiveMetric] = useState('gpu_util');

  const selectedMetricsRef = useRef(selectedMetrics);
  const activeMetricRef = useRef(activeMetric);
  const historyRef = useRef(history);

  // keep activeMetric in sync with selectedMetrics
  useEffect(() => {
    if (!selectedMetrics.has(activeMetric)) {
      setActiveMetric(selectedMetrics.size ? [...selectedMetrics][0] : null);
    }
  }, [selectedMetrics]);

  // keep refs in sync so websocket handlers can read latest selection
  useEffect(() => { selectedSetRef.current = selectedSet; }, [selectedSet]);
  useEffect(() => { selectedMetricsRef.current = selectedMetrics; }, [selectedMetrics]);
  useEffect(() => { activeMetricRef.current = activeMetric; }, [activeMetric]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // helper: find nearest sample in history array to given timestamp
  const findNearest = (arr, ts) => {
    if (!arr || arr.length === 0) return null;
    let nearest = null;
    let min = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs((arr[i].timestamp || 0) - ts);
      if (d < min) { min = d; nearest = arr[i]; }
    }
    return (min <= TOLERANCE_SEC) ? nearest : nearest; // even if beyond tolerance, return nearest (less strict)
  };

  const buildPoint = (ts, indices, metricDef, historySnapshot, payloadGpus) => {
    const point = { time: ts * 1000, timeLabel: new Date(ts * 1000).toLocaleTimeString() };
    indices.forEach(idx => {
      let val = null;
      // prefer payload latest value if available
      if (Array.isArray(payloadGpus)) {
        const fromPayload = payloadGpus.find(g => g.gpu_index === idx);
        if (fromPayload) val = metricDef.accessor(fromPayload);
      }
      if (val === null) {
        const arr = historySnapshot[idx] || [];
        const nearest = findNearest(arr, ts);
        if (nearest) val = metricDef.accessor(nearest);
      }
      point[`g${idx}`] = (val !== undefined ? val : null);
    });
    return point;
  };

  useEffect(() => {
    let mounted = true;

    const connectTo = (url) => {
      if (!mounted) return;
      setConnectionStatus('connecting');
      setLastError(null);
      console.log('Attempt connect to', url);

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.addEventListener('open', () => {
          console.log('ws open', url);
          backoffRef.current = { attempt: 0, ms: 1000 };
          setConnectionStatus('open');
        });

        ws.addEventListener('message', (ev) => {
          setRawMessage(ev.data);
          try {
            const data = JSON.parse(ev.data);
            if (!data || !Array.isArray(data.gpus)) {
              console.warn('WS: unexpected payload', data);
              return;
            }
            setGpuData(data);
            // 为每个 GPU 维护独立的历史数据
            setHistory(prev => {
              const next = { ...prev };
              data.gpus.forEach(gpu => {
                if (!next[gpu.gpu_index]) next[gpu.gpu_index] = [];
                next[gpu.gpu_index] = [...next[gpu.gpu_index], { timestamp: data.timestamp, ...gpu }];
                if (next[gpu.gpu_index].length > 60) next[gpu.gpu_index].shift();
              });

                // 为每个选中的监控项分别更新图表数据
                try {
                  const sel = Array.from(selectedSetRef.current || []);
                  if (sel.length > 0) {
                    const currentTime = data.timestamp;
                    const tick = Math.floor(currentTime / CHART_STEP_SEC) * CHART_STEP_SEC;

                    setChartDataMap(prevChartDataMap => {
                      const newChartDataMap = { ...prevChartDataMap };

                      // 为每个监控指标更新数据
                      metricsCatalog.forEach(metricDef => {
                        if (!selectedMetricsRef.current.has(metricDef.key)) return;

                        const newPoint = buildPoint(tick, sel, metricDef, next, data.gpus);
                        const currentChart = newChartDataMap[metricDef.key] || [];
                        
                        // 检查是否需要更新最后一个点或添加新点
                        const lastPoint = currentChart[currentChart.length - 1];
                        if (lastPoint && Math.abs(lastPoint.time/1000 - tick) < TOLERANCE_SEC) {
                          // 更新最后一个点的数据
                          const updatedChart = [...currentChart];
                          updatedChart[updatedChart.length - 1] = newPoint;
                          newChartDataMap[metricDef.key] = updatedChart;
                        } else {
                          // 添加新点并保持固定窗口大小
                          newChartDataMap[metricDef.key] = [...currentChart, newPoint].slice(-CHART_MAX);
                        }
                      });

                      return newChartDataMap;
                    });
                  }
                } catch (e) {
                  console.warn('chart append error', e);
                }              return next;
            });
          } catch (e) {
            console.warn('invalid ws msg', e);
            setLastError(String(e));
          }
        });

        ws.addEventListener('error', (error) => {
          console.error('WebSocket error:', error);
          setLastError(String(error));
          setConnectionStatus('error');
        });

        ws.addEventListener('close', (ev) => {
          console.log('ws closed', ev);
          setConnectionStatus('closed');
          if (!mounted) return;
          // exponential backoff reconnect to same endpoint
          backoffRef.current.attempt += 1;
          backoffRef.current.ms = Math.min(30000, backoffRef.current.ms * 2);
          // only auto-reconnect if running
          if (running) reconnectTimer.current = setTimeout(() => connectTo(url), backoffRef.current.ms);
        });
      } catch (err) {
        console.error('ws connect failed', err);
        setLastError(String(err));
        setConnectionStatus('error');
        if (mounted && running) reconnectTimer.current = setTimeout(() => connectTo(url), 2000);
      }
    };

    // initial connect using selected endpoint only if running
    if (running) connectTo(endpoint);

    return () => {
      mounted = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      try { wsRef.current?.close(); } catch (e) {}
    };
  }, [endpoint, running]);

  // rebuild chartData when selection changes (re-align using fixed ticks)
  // initialize chart data for all selected metrics
  useEffect(() => {
    const sel = Array.from(selectedSet);
    if (!sel.length) {
      setChartDataMap({});
      return;
    }
    
    // gather union of timestamps from histories
    const hist = historyRef.current || {};
    const allT = new Set();
    sel.forEach(idx => (hist[idx] || []).forEach(d => {
      const t = Math.round(d.timestamp / CHART_STEP_SEC) * CHART_STEP_SEC;
      allT.add(t);
    }));
    const times = Array.from(allT).sort();
    
    // initialize data for all selected metrics
    const newChartDataMap = {};
    selectedMetricsRef.current.forEach(metricKey => {
      const metricDef = metricsCatalog.find(m => m.key === metricKey);
      if (!metricDef) return;
      
      const next = times.map(t => buildPoint(t, sel, metricDef, hist, null));
      newChartDataMap[metricKey] = next.slice(-CHART_MAX);
    });
    
    setChartDataMap(newChartDataMap);
  }, [selectedSet, activeMetric]);

  return (
    <Box sx={{ flexGrow: 1, p: 2 }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            gpuUtils — Live GPU metrics (mock)
          </Typography>
          <Typography variant="body2" sx={{ mr: 2 }}>Pod: <strong>{podName}</strong></Typography>
          <Button color={running ? 'error' : 'inherit'} variant={running ? 'contained' : 'outlined'} onClick={() => {
            setRunning((r) => {
              const next = !r;
              if (next) {
                if ((selectedSet?.size || 0) === 0) {
                  const s = new Set([0]);
                  setSelectedSet(s);
                }
              }
              return next;
            });
          }}>{running ? 'Stop' : 'Start'}</Button>
          <Button sx={{ ml: 1 }} color="secondary" variant="outlined" onClick={() => { setSelectedSet(new Set()); setGpuData(null); setHistory({}); setChartDataMap({}); }}>Reset</Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ mt: 2 }}>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>Connection (debug)</AccordionSummary>
          <AccordionDetails>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
                {endpointCandidates.map((ep) => <option key={ep} value={ep}>{ep}</option>)}
                <option key="manual" value={manualEndpoint || endpoint}>Manual...</option>
              </select>
              <input style={{ flex: '1 1 320px' }} placeholder="Or paste ws://host:8000/ws" value={manualEndpoint} onChange={(e) => setManualEndpoint(e.target.value)} />
              <Button onClick={() => { if (manualEndpoint) setEndpoint(manualEndpoint); else setEndpoint(endpoint) }}>Connect</Button>
              <Button onClick={() => { try { wsRef.current?.close(); } catch (e) {} }}>Disconnect</Button>
            </Box>
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2">Status: {connectionStatus}{lastError ? ` • ${lastError}` : ''}</Typography>
            </Box>
          </AccordionDetails>
        </Accordion>
      </Box>

      <Box sx={{ mt: 2 }}>
        {gpuData ? (
          <>
            <Box sx={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(8, 1fr)', 
                gap: 2,
                overflowX: 'auto',
                '& > *': { minWidth: '260px' }
              }}>
              {gpuData.gpus.map((gpu) => (
                <Box key={gpu.gpu_index} sx={{ position: 'relative' }}>
                  <Card variant="outlined" onClick={() => {
                    // toggle GPU selection for charting; also set selectedGpu for detailed view
                    const s = new Set(selectedSet);
                    if (s.has(gpu.gpu_index)) s.delete(gpu.gpu_index);
                    else s.add(gpu.gpu_index);
                    setSelectedSet(s);

                  }} sx={{ 
                    cursor: 'pointer',
                    backgroundColor: selectedSet.has(gpu.gpu_index) ? '#f3f4f6' : 'white',
                    transition: 'background-color 0.2s ease'
                  }}>
                    <CardContent>
                      <Typography variant="subtitle1">{gpu.name}</Typography>
                      <Box sx={{ mt: 1 }}>
                        <Box sx={{ height: 8, bgcolor: '#e5e7eb', borderRadius: 1, overflow: 'hidden' }}>
                          <Box sx={{ width: `${gpu.gpu_util}%`, height: '100%', bgcolor: getUtilColor(gpu.gpu_util) }} />
                        </Box>
                        <Typography variant="caption">GPU: {gpu.gpu_util}%</Typography>
                      </Box>
                      <Box sx={{ mt: 1 }}>
                        <Box sx={{ height: 8, bgcolor: '#e5e7eb', borderRadius: 1, overflow: 'hidden' }}>
                          <Box sx={{ width: `${gpu.mem_util}%`, height: '100%', bgcolor: getUtilColor(gpu.mem_util) }} />
                        </Box>
                        <Typography variant="caption">MEM: {gpu.mem_util}%</Typography>
                      </Box>
                      <Typography variant="caption" display="block" sx={{ mt: 1 }}>Temp: {gpu.temperature}°C</Typography>
                    </CardContent>
                  </Card>
                </Box>
              ))}
            </Box>

            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '280px 1fr' }, gap: 2, alignItems: 'start' }}>
                <Paper sx={{ p: 2 }}>
                  <Typography variant="h6">监控项 (Metrics)</Typography>
                  <List>
                    {metricsCatalog.map((m) => (
                      <ListItem key={m.key} dense>
                        <Checkbox edge="start" checked={selectedMetrics.has(m.key)} onChange={(e) => {
                          const s = new Set(selectedMetrics);
                          if (e.target.checked) s.add(m.key); else s.delete(m.key);
                          setSelectedMetrics(s);
                          if (!s.has(activeMetric) && s.size > 0) setActiveMetric([...s][0]);
                        }} />
                        <ListItemText primary={m.label} secondary={`单位: ${m.unit}`} />
                      </ListItem>
                    ))}
                  </List>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="body2">Selected GPUs: {Array.from(selectedSet).length} (点击卡片切换)</Typography>
                </Paper>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
                  {Array.from(selectedMetrics).map(metricKey => {
                    const metric = metricsCatalog.find(m => m.key === metricKey);
                    if (!metric) return null;
                    
                    return (
                      <Paper key={metricKey} sx={{ p: 2, width: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Typography variant="h6">{metric.label}</Typography>
                          <Typography variant="caption">单位: {metric.unit}</Typography>
                        </Box>

                        <Box sx={{ mt: 1, height: 320, width: '100%', minWidth: 0, flex: '1 1 auto', display: 'flex' }}>
                          {Array.from(selectedSet).length === 0 ? (
                            <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                              <Typography color="text.secondary">Select GPUs (点击卡片) to show chart</Typography>
                            </Box>
                          ) : (
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart 
                                data={chartDataMap[metricKey] || []}
                                syncId={`gpu-chart-${metricKey}`}
                              >
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis 
                                  dataKey="timeLabel" 
                                  allowDataOverflow={true}
                                  minTickGap={50}
                                  interval="preserveStartEnd"
                                />
                                <YAxis 
                                  unit={metric.unit}
                                  allowDataOverflow={true}
                                  domain={['auto', 'auto']}
                                />
                                <Tooltip 
                                  isAnimationActive={false}
                                  cursor={{ stroke: '#666', strokeWidth: 1 }}
                                />
                                <Legend />
                                {Array.from(selectedSet).map((gpuIndex, si) => (
                                  <Line 
                                    key={gpuIndex} 
                                    type="monotoneX" 
                                    dataKey={`g${gpuIndex}`} 
                                    name={`GPU ${gpuIndex}`} 
                                    stroke={["#3b82f6","#10b981","#ef4444","#f97316","#7c3aed","#06b6d4"][si % 6]} 
                                    strokeWidth={2}
                                    dot={false}
                                    isAnimationActive={true}
                                    animationDuration={CHART_ANIMATION_DURATION}
                                    animationEasing="ease-in-out"
                                  />
                                ))}
                              </LineChart>
                            </ResponsiveContainer>
                          )}
                        </Box>
                      </Paper>
                    );
                  })}
                </Box>
              </Box>
            </Box>

            {/* Device info section removed */}
          </>
        ) : (
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">Connecting to GPU Service...</Typography>
            <Typography color="text.secondary">Establishing WebSocket connection...</Typography>
          </Paper>
        )}
      </Box>

      <Box sx={{ mt: 2 }}>
        <Paper sx={{ p: 1 }}>
          <Typography variant="caption">Endpoint: <code>ws://localhost:8000/ws</code></Typography>
          <Typography variant="caption" sx={{ display: 'block' }}>Status: {connectionStatus}{lastError ? ` • Error: ${lastError}` : ''}</Typography>
          <Typography variant="caption" sx={{ display: 'block' }}>Last update: {gpuData ? new Date(gpuData.timestamp * 1000).toLocaleTimeString() : 'N/A'}</Typography>
        </Paper>
      </Box>
    </Box>
  );
}
