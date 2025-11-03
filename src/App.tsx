import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

type Dir = { x: number; y: number };

function getSessionId(): string {
  const key = "snake_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, id);
  }
  return id;
}

export default function App() {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const isAdmin = path === "/admin";
  return (
      <main className="p-4">
      {isAdmin ? <Admin /> : <Game />}
    </main>
  );
}

function Game() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [name, setName] = useState<string>(localStorage.getItem("snake_name") || "");
  const [color, setColor] = useState<string>(localStorage.getItem("snake_color") || "");
  const sessionId = useMemo(() => getSessionId(), []);

  const join = useMutation(api.game.join);
  const leave = useMutation(api.game.leave);
  const heartbeat = useMutation(api.game.heartbeat);
  const setDirection = useMutation(api.game.setDirection);
  const superEat = useMutation(api.game.superEat);
  const triggerTick = useMutation(api.game.tick);

  const state = useQuery(api.game.getState, {});

  useEffect(() => {
    if (!name) return;
    if (!color) {
      const palette = ["#e74c3c", "#3498db", "#2ecc71", "#9b59b6", "#f1c40f", "#e67e22", "#1abc9c", "#e84393"];
      const c = palette[Math.floor(Math.random() * palette.length)];
      setColor(c);
      localStorage.setItem("snake_color", c);
    }
    join({ sessionId, name, color: color || undefined });
    const onPageHide = () => {
      const url = `${import.meta.env.VITE_CONVEX_URL}/leave`;
      try {
        const blob = new Blob([JSON.stringify({ sessionId })], { type: "application/json" });
        navigator.sendBeacon(url, blob);
      } catch {}
      try {
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
          keepalive: true,
          mode: "cors",
        }).catch(() => {});
      } catch {}
      // last resort
      leave({ sessionId });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    };
  }, [name, color, sessionId, join, leave]);

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => {
      triggerTick({});
      heartbeat({ sessionId });
    }, state.tickMs);
    return () => clearInterval(id);
  }, [state, triggerTick, heartbeat, sessionId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      let dir: Dir | null = null;
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          dir = { x: 0, y: -1 }; break;
        case "ArrowDown":
        case "s":
        case "S":
          dir = { x: 0, y: 1 }; break;
        case "ArrowLeft":
        case "a":
        case "A":
          dir = { x: -1, y: 0 }; break;
        case "ArrowRight":
        case "d":
        case "D":
          dir = { x: 1, y: 0 }; break;
        case " ":
        case "Spacebar":
          // consume super-fruit power if available
          superEat({ sessionId });
          return;
      }
      if (dir) setDirection({ sessionId, dir });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setDirection, sessionId]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !state) return;
    const gridSize = 20; // pixels per cell
    const width = state.gridWidth * gridSize;
    const height = state.gridHeight * gridSize;
    const canvas = canvasRef.current!;
    canvas.width = width;
    canvas.height = height;

    ctx.fillStyle = "#111827"; // slate-900
    ctx.fillRect(0, 0, width, height);

    // Grid (subtle)
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }

    // Fruits
    for (const f of state.fruits) {
      // draw fruit base (normal: red, super: gold)
      if (f.isSuper) {
        ctx.fillStyle = "#f59e0b"; // amber-500
        ctx.fillRect(f.x * gridSize + 2, f.y * gridSize + 2, gridSize - 4, gridSize - 4);
        // bright gold outline for super-fruit
        ctx.strokeStyle = "#fbbf24"; // amber-400
        ctx.lineWidth = 2.5;
        ctx.strokeRect(f.x * gridSize + 1.5, f.y * gridSize + 1.5, gridSize - 3, gridSize - 3);
      } else {
        ctx.fillStyle = "#ef4444"; // red-500
        ctx.fillRect(f.x * gridSize + 2, f.y * gridSize + 2, gridSize - 4, gridSize - 4);
      }
    }

    // Players
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "top";
    const me = state.players.find((p) => p.sessionId === sessionId);
    // If I have super, find closest snake to highlight
    let closestTarget: typeof state.players[number] | null = null;
    if (me?.hasSuper) {
      const head = me.body[0];
      if (head) {
        const w = state.gridWidth, h = state.gridHeight;
        const dist2 = (a: {x:number;y:number}, b: {x:number;y:number}) => {
          const dx = Math.min(Math.abs(a.x - b.x), w - Math.abs(a.x - b.x));
          const dy = Math.min(Math.abs(a.y - b.y), h - Math.abs(a.y - b.y));
          return dx*dx + dy*dy;
        };
        for (const p of state.players) {
          if (p.sessionId === sessionId || !p.alive) continue;
          const h2 = p.body[0];
          if (!h2) continue;
          if (!closestTarget || dist2(head, h2) < dist2(head, closestTarget.body[0])) {
            closestTarget = p;
          }
        }
      }
    }

    for (const p of state.players) {
      const isSelf = p.sessionId === sessionId;
      ctx.globalAlpha = p.alive ? 1.0 : 0.35;
      // draw tail segments first in body color
      ctx.fillStyle = p.color;
      for (let i = p.body.length - 1; i >= 1; i--) {
        const seg = p.body[i];
        const inset = 3;
        ctx.fillRect(seg.x * gridSize + inset, seg.y * gridSize + inset, gridSize - inset * 2, gridSize - inset * 2);
        if (isSelf) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.strokeRect(seg.x * gridSize + inset - 1, seg.y * gridSize + inset - 1, gridSize - (inset - 1) * 2, gridSize - (inset - 1) * 2);
        }
      }
      // draw head with special color if bot
      const head = p.body[0];
      if (head) {
        const headInset = 1;
        if (p.isBot) {
          // bot head: bright contrast color
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(head.x * gridSize + headInset, head.y * gridSize + headInset, gridSize - headInset * 2, gridSize - headInset * 2);
          // outline for visibility
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2;
          ctx.strokeRect(head.x * gridSize + headInset + 1, head.y * gridSize + headInset + 1, gridSize - (headInset + 1) * 2, gridSize - (headInset + 1) * 2);
        } else {
          ctx.fillStyle = p.color;
          ctx.fillRect(head.x * gridSize + headInset, head.y * gridSize + headInset, gridSize - headInset * 2, gridSize - headInset * 2);
        }
        if (isSelf) {
          // Extra highlight for the local player's head
          ctx.strokeStyle = "#fbbf24"; // amber-400
          ctx.lineWidth = 3;
          ctx.strokeRect(head.x * gridSize + headInset - 1.5, head.y * gridSize + headInset - 1.5, gridSize - (headInset - 1.5) * 2, gridSize - (headInset - 1.5) * 2);
        }
        if (closestTarget && p.sessionId === closestTarget.sessionId) {
          // Highlight closest target if I have super
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = 3;
          ctx.strokeRect(head.x * gridSize + headInset - 1.5, head.y * gridSize + headInset - 1.5, gridSize - (headInset - 1.5) * 2, gridSize - (headInset - 1.5) * 2);
        }
      }
      // Label
      if (head) {
        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(`${p.name} (${p.score})`, head.x * gridSize + 2, head.y * gridSize + 2);
      }
      ctx.globalAlpha = 1.0;
    }
  }, [state, sessionId]);

  if (!name) {
    return <NamePrompt onSubmit={(n) => {
      const trimmed = n.trim().slice(0, 24) || `Player-${Math.random().toString(36).slice(2,5)}`;
      setName(trimmed);
      localStorage.setItem("snake_name", trimmed);
    }} />;
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm text-slate-500">Signed in as</span>
        <strong>{name}</strong>
      </div>
      <canvas ref={canvasRef} className="border border-slate-700 rounded shadow" />
      {!state && <div className="text-slate-400">Loading state…</div>}
      {state && (
        <div className="fixed top-2 right-2 bg-black/40 text-slate-200 border border-slate-700 rounded p-2 min-w-44">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Leaderboard</div>
          <ul className="text-sm">
            {[...state.players]
              .sort((a, b) => b.score - a.score)
              .slice(0, 8)
              .map((p) => {
                const me = p.sessionId === sessionId;
                return (
                  <li key={p.sessionId} className={`flex items-center justify-between gap-3 ${me ? "text-amber-300" : ""}`}>
                    <span className="truncate max-w-36" title={p.name}>{p.name}{p.isBot ? " (bot)" : ""}</span>
                    <span className="tabular-nums">{p.score}</span>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}

function NamePrompt({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="max-w-md mx-auto p-6 border border-slate-200 rounded">
      <h2 className="text-xl font-semibold mb-2">Enter your name</h2>
      <p className="text-slate-500 mb-4">This will label your snake.</p>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(value); }} className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. Alice"
          className="flex-1 border px-3 py-2 rounded"
        />
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded">Join</button>
      </form>
      <ul className="text-slate-400 mb-4 list-disc list-inside text-sm mt-4">
        <li>The is a simple, online snake game.</li>
        <li>You can move your snake with the arrow keys or WASD.</li>
        <li>Your snake will have a <p className="inline-block px-1 py-0.5 bg-amber-400 text-black rounded">yellow border</p> around it's head.</li>
        <li>Snakes will grow 1 point when they eat a fruit.</li>
        <li>Any snake will be eliminated if they hit another snake (including itself).</li>
        <li>Occassionally, the game will generate a <p className="inline-block px-1 py-0.5 bg-red-500 text-white rounded">super-fruit</p> which allows you to eat the closest snake. If you have the super-fruit, the closest snake will be shown in a red border.</li>
      </ul>
    </div>
  );
}

function Admin() {
  const state = useQuery(api.game.getState, {});
  const setConfig = useMutation(api.game.adminSetConfig);
  const restart = useMutation(api.game.adminRestart);
  const wipe = useMutation(api.game.adminWipe);

  const [tickMs, setTickMs] = useState<string>("");
  const [gridW, setGridW] = useState<string>("");
  const [gridH, setGridH] = useState<string>("");
  const [fruits, setFruits] = useState<string>("");
  const [bots, setBots] = useState<string>("");

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-4">
      <div className="text-slate-600 text-sm">No auth; anyone on /admin can control the game.</div>
      <div className="p-4 border rounded">
        <h3 className="font-semibold mb-2">Current</h3>
        {state ? (
          <ul className="text-sm flex flex-col gap-1">
            <li>tickMs: <strong>{state.tickMs}</strong></li>
            <li>grid: <strong>{state.gridWidth} × {state.gridHeight}</strong></li>
            <li>players: <strong>{state.players.length}</strong></li>
            <li>bots: <strong>{state.players.filter((p) => p.isBot).length}</strong></li>
            <li>fruits: <strong>{state.fruits.length}</strong></li>
          </ul>
        ) : (
          <div className="text-slate-500">Loading…</div>
        )}
      </div>

      <div className="p-4 border rounded flex flex-col gap-2">
        <h3 className="font-semibold">Update Config</h3>
        <div className="grid grid-cols-2 gap-2">
          <input className="border px-2 py-1 rounded" placeholder="tickMs"
                 value={tickMs} onChange={(e) => setTickMs(e.target.value)} />
          <input className="border px-2 py-1 rounded" placeholder="grid width"
                 value={gridW} onChange={(e) => setGridW(e.target.value)} />
          <input className="border px-2 py-1 rounded" placeholder="grid height"
                 value={gridH} onChange={(e) => setGridH(e.target.value)} />
          <input className="border px-2 py-1 rounded" placeholder="max fruits"
                 value={fruits} onChange={(e) => setFruits(e.target.value)} />
          <input className="border px-2 py-1 rounded" placeholder="target bots"
                 value={bots} onChange={(e) => setBots(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1 rounded bg-blue-600 text-white cursor-pointer"
                  onClick={() => setConfig({
                    tickMs: tickMs ? Number(tickMs) : undefined,
                    gridWidth: gridW ? Number(gridW) : undefined,
                    gridHeight: gridH ? Number(gridH) : undefined,
                    maxFruits: fruits ? Number(fruits) : undefined,
                    targetBots: bots ? Number(bots) : undefined,
                  })}>Apply</button>
          <button className="px-3 py-1 rounded border cursor-pointer"
                  onClick={() => { setTickMs(""); setGridW(""); setGridH(""); setFruits(""); setBots(""); }}>Clear</button>
        </div>
      </div>

      <div className="p-4 border rounded flex gap-2">
        <button className="px-3 py-1 rounded bg-emerald-600 text-white cursor-pointer"
                onClick={() => restart({ tickMs: tickMs ? Number(tickMs) : undefined })}>Restart (keep players)</button>
        <button className="px-3 py-1 rounded bg-rose-600 text-white cursor-pointer"
                onClick={() => wipe({ tickMs: tickMs ? Number(tickMs) : undefined })}>Wipe (remove players)</button>
      </div>
    </div>
  );
}

