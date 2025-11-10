import React, { useEffect, useState, useRef } from "react";
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
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
  const [chartData, setChartData] = useState([]);
  const CHART_MAX = 120;
  const CHART_STEP_SEC = 1; // fixed timeline step (seconds)
  const TOLERANCE_SEC = 1.5; // nearest-sample tolerance in seconds
  const [selectedGpu, setSelectedGpu] = useState(0);
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

  const activeMetricRef = useRef(activeMetric);

  // keep activeMetric in sync with selectedMetrics
  useEffect(() => {
    if (!selectedMetrics.has(activeMetric)) {
      setActiveMetric(selectedMetrics.size ? [...selectedMetrics][0] : null);
    }
  }, [selectedMetrics]);

  // keep refs in sync so websocket handlers can read latest selection
  useEffect(() => { selectedSetRef.current = selectedSet; }, [selectedSet]);
  useEffect(() => { activeMetricRef.current = activeMetric; }, [activeMetric]);

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

              // incrementally append to chartData using the incoming payload and current selection
              try {
                const sel = Array.from(selectedSetRef.current || []);
                const metricKey = activeMetricRef.current;
                if (sel.length > 0 && metricKey) {
                  const metricDef = metricsCatalog.find(m => m.key === metricKey) || metricsCatalog[0];
                  // align to fixed timeline tick
                  const tick = Math.round(data.timestamp / CHART_STEP_SEC) * CHART_STEP_SEC;
                  const newPoint = buildPoint(tick, sel, metricDef, next, data.gpus);
                  setChartData(prevChart => {
                    if (prevChart.length && prevChart[prevChart.length - 1].time === newPoint.time) {
                      // replace last point with refreshed values for same tick
                      const copy = prevChart.slice();
                      copy[copy.length - 1] = newPoint;
                      return copy;
                    }
                    return [...prevChart, newPoint].slice(-CHART_MAX);
                  });
                }
              } catch (e) {
                console.warn('chart append error', e);
              }

              return next;
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

  // rebuild chartData when selection or active metric changes (re-align using fixed ticks)
  useEffect(() => {
    const sel = Array.from(selectedSet);
    const metricKey = activeMetric;
    if (!sel.length || !metricKey) {
      setChartData([]);
      return;
    }
    const metricDef = metricsCatalog.find(m => m.key === metricKey) || metricsCatalog[0];
    // gather union of timestamps from histories and round to step
    const allT = new Set();
    sel.forEach(idx => (history[idx] || []).forEach(d => {
      const t = Math.round(d.timestamp / CHART_STEP_SEC) * CHART_STEP_SEC;
      allT.add(t);
    }));
    const times = Array.from(allT).sort();
    const next = times.map(t => buildPoint(t, sel, metricDef, history, null));
    setChartData(next.slice(-CHART_MAX));
  }, [selectedSet, activeMetric, history]);

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
                  setSelectedGpu(0);
                }
              }
              return next;
            });
          }}>{running ? 'Stop' : 'Start'}</Button>
          <Button sx={{ ml: 1 }} color="secondary" variant="outlined" onClick={() => { setSelectedSet(new Set()); setGpuData(null); setHistory({}); setChartData([]); }}>Reset</Button>
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
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2 }}>
              {gpuData.gpus.map((gpu) => (
                <Box key={gpu.gpu_index} sx={{ position: 'relative' }}>
                  <Card variant="outlined" onClick={() => {
                    // toggle GPU selection for charting; also set selectedGpu for detailed view
                    const s = new Set(selectedSet);
                    if (s.has(gpu.gpu_index)) s.delete(gpu.gpu_index);
                    else s.add(gpu.gpu_index);
                    setSelectedSet(s);
                    setSelectedGpu(gpu.gpu_index);
                  }} sx={{ cursor: 'pointer' }}>
                    <CardContent>
                      {/* selection feedback */}
                      {selectedSet.has(gpu.gpu_index) && (
                        <Chip label="Selected" size="small" color="primary" sx={{ position: 'absolute', right: 8, top: 8 }} />
                      )}
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

                <Paper sx={{ p: 2, width: '100%', display: 'flex', flexDirection: 'column' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="h6">Realtime Chart</Typography>
                    <Box>
                      <Typography variant="caption" sx={{ mr: 1 }}>Metric:</Typography>
                      {selectedMetrics.size === 0 ? (
                        <Typography variant="caption" color="text.secondary">Select a metric</Typography>
                      ) : (
                        <select value={activeMetric || ''} onChange={(e) => setActiveMetric(e.target.value)}>
                          {[...selectedMetrics].map(k => {
                            const m = metricsCatalog.find(x => x.key === k);
                            return m ? <option value={m.key} key={m.key}>{m.label} ({m.unit})</option> : null;
                          })}
                        </select>
                      )}
                    </Box>
                  </Box>

                  <Box sx={{ mt: 1, height: 320, width: '100%', minWidth: 0, flex: '1 1 auto', display: 'flex' }}>
                    {Array.from(selectedSet).length === 0 && <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}><Typography color="text.secondary">Select GPUs (点击卡片) to show chart</Typography></Box>}
                    {Array.from(selectedSet).length > 0 && activeMetric && (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="timeLabel" />
                          <YAxis unit={metricsCatalog.find(m => m.key === activeMetric)?.unit} />
                          <Tooltip />
                          <Legend />
                          {Array.from(selectedSet).map((gpuIndex, si) => (
                            <Line key={gpuIndex} type="monotone" dataKey={`g${gpuIndex}`} name={`GPU ${gpuIndex}`} stroke={["#3b82f6","#10b981","#ef4444","#f97316","#7c3aed","#06b6d4"][si % 6]} dot={false} />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </Box>
                  <Typography variant="caption">Y unit: {activeMetric ? (metricsCatalog.find(m => m.key === activeMetric)?.unit) : '-'}</Typography>
                </Paper>
              </Box>
            </Box>

            {/* Detailed stats for selected GPU */}
            {gpuData.gpus[selectedGpu] && (
              <Box sx={{ mt: 2 }}>
                <Card>
                          <CardContent>
                            <Typography variant="h6">Device Info - {gpuData.gpus[selectedGpu].name}</Typography>
                            <Grid container spacing={2} sx={{ mt: 1 }}>
                              <Grid item xs={12} md={4}>
                                <Paper sx={{ p: 2 }}>
                                  <Typography variant="subtitle2">Identity</Typography>
                                  <div>GPU ID: {gpuData.gpus[selectedGpu].gpu_index}</div>
                                  <div>Model: {gpuData.gpus[selectedGpu].name}</div>
                                </Paper>
                              </Grid>
                              <Grid item xs={12} md={4}>
                                <Paper sx={{ p: 2 }}>
                                  <Typography variant="subtitle2">Memory / Clocks</Typography>
                                  <div>Total Memory: {gpuData.gpus[selectedGpu].memory?.total ?? 'N/A'} MB</div>
                                  <div>Graphics Clock: {gpuData.gpus[selectedGpu].clocks?.graphics ?? 'N/A'} MHz</div>
                                  <div>Memory Clock: {gpuData.gpus[selectedGpu].clocks?.memory ?? 'N/A'} MHz</div>
                                </Paper>
                              </Grid>
                              <Grid item xs={12} md={4}>
                                <Paper sx={{ p: 2 }}>
                                  <Typography variant="subtitle2">Static Status</Typography>
                                  <div>Performance State: {gpuData.gpus[selectedGpu].performance_state}</div>
                                  <div>PCIe / NvLink: see metrics</div>
                                </Paper>
                              </Grid>
                            </Grid>
                          </CardContent>
                </Card>
              </Box>
            )}
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
