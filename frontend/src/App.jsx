import React, { useEffect, useState, useRef } from "react";

export default function App() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":8000/ws";
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      console.log("ws open", url);
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setLatest(data);
        setHistory((h) => {
          const next = [...h, data];
          if (next.length > 60) next.shift();
          return next;
        });
      } catch (e) {
        console.warn("invalid ws msg", e);
      }
    });

    ws.addEventListener("close", () => console.log("ws closed"));

    return () => {
      try {
        ws.close();
      } catch (e) {}
    };
  }, []);

  return (
    <div className="container">
      <header>
        <h1>gpuUtils — Live GPU metrics (mock)</h1>
      </header>

      <section className="card">
        <h2>Latest</h2>
        {latest ? (
          <div className="grid">
            <div>GPU #{latest.gpu_index}</div>
            <div>GPU Util: {latest.gpu_util}%</div>
            <div>Mem Util: {latest.mem_util}%</div>
            <div>Temp: {latest.temperature} °C</div>
            <div>Fan: {latest.fan_speed}%</div>
            <div>Time: {new Date(latest.timestamp * 1000).toLocaleTimeString()}</div>
          </div>
        ) : (
          <div>Connecting…</div>
        )}
      </section>

      <section className="card">
        <h2>GPU Util (last {history.length} samples)</h2>
        <div className="sparkline">
          {history.length === 0 && <div className="muted">no data yet</div>}
          {history.length > 0 && (
            <svg viewBox="0 0 600 50" preserveAspectRatio="none">
              {(() => {
                const w = 600;
                const h = 50;
                const max = Math.max(...history.map((d) => d.gpu_util));
                const min = Math.min(...history.map((d) => d.gpu_util));
                const range = max - min || 1;
                return history.map((d, i) => {
                  const x = (i / Math.max(1, history.length - 1)) * w;
                  const y = h - ((d.gpu_util - min) / range) * h;
                  return <circle key={i} cx={x} cy={y} r={2} fill="#3b82f6" />;
                });
              })()}
            </svg>
          )}
        </div>
      </section>

      <footer className="muted">Connects to ws://localhost:8000/ws — mock data</footer>
    </div>
  );
}
