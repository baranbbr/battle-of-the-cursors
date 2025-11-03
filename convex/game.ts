import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const GLOBAL_KEY = "global";
const DEFAULTS = {
  gridWidth: 40,
  gridHeight: 28,
  tickMs: 120,
  maxFruits: 6,
  targetBots: 3,
};

type Vec = { x: number; y: number };

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function randomColor(): string {
  const colors = ["#e74c3c", "#3498db", "#2ecc71", "#9b59b6", "#f1c40f", "#e67e22", "#1abc9c", "#e84393"];
  return colors[Math.floor(Math.random() * colors.length)];
}

async function getOrInitState(ctx: any) {
  const existing = await ctx.db
    .query("state")
    .withIndex("by_key", (q: any) => q.eq("key", GLOBAL_KEY))
    .unique();
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("state", {
    key: GLOBAL_KEY,
    gridWidth: DEFAULTS.gridWidth,
    gridHeight: DEFAULTS.gridHeight,
    tickMs: DEFAULTS.tickMs,
    lastTickAt: now,
    maxFruits: DEFAULTS.maxFruits,
    targetBots: DEFAULTS.targetBots,
  });
  return await ctx.db.get(id);
}

function nextPos(head: Vec, dir: Vec, w: number, h: number): Vec {
  const nx = (head.x + dir.x + w) % w;
  const ny = (head.y + dir.y + h) % h;
  return { x: nx, y: ny };
}

function vecEq(a: Vec, b: Vec): boolean {
  return a.x === b.x && a.y === b.y;
}

export const getState = query({
  args: {},
  returns: v.object({
    gridWidth: v.number(),
    gridHeight: v.number(),
    tickMs: v.number(),
    players: v.array(
      v.object({
        sessionId: v.string(),
        name: v.string(),
        color: v.string(),
        body: v.array(v.object({ x: v.number(), y: v.number() })),
        alive: v.boolean(),
        isBot: v.boolean(),
        score: v.number(),
      })
    ),
    fruits: v.array(v.object({ x: v.number(), y: v.number() })),
  }),
  handler: async (ctx) => {
    // Queries cannot write; read state if present, otherwise use defaults
    const s = await ctx.db
      .query("state")
      .withIndex("by_key", (q: any) => q.eq("key", GLOBAL_KEY))
      .unique();
    const players = await ctx.db.query("players").collect();
    const fruits = await ctx.db.query("fruits").collect();
    return {
      gridWidth: s?.gridWidth ?? DEFAULTS.gridWidth,
      gridHeight: s?.gridHeight ?? DEFAULTS.gridHeight,
      tickMs: s?.tickMs ?? DEFAULTS.tickMs,
      players: players.map((p: any) => ({
        sessionId: p.sessionId,
        name: p.name,
        color: p.color,
        body: p.body,
        alive: p.alive,
        isBot: p.isBot,
        score: p.score,
      })),
      fruits: fruits.map((f: any) => ({ x: f.x, y: f.y })),
    };
  },
});

export const join = mutation({
  args: {
    sessionId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, name, color }) => {
    await getOrInitState(ctx);
    const existing = await ctx.db
      .query("players")
      .withIndex("by_session", (q: any) => q.eq("sessionId", sessionId))
      .unique();
    const now = Date.now();
    const snake: Array<Vec> = [
      { x: randomInt(DEFAULTS.gridWidth), y: randomInt(DEFAULTS.gridHeight) },
    ];
    const dir = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }][randomInt(4)];
    if (!existing) {
      await ctx.db.insert("players", {
        sessionId,
        name,
        color: color ?? randomColor(),
        body: snake,
        direction: dir,
        alive: true,
        isBot: false,
        score: 0,
        lastSeen: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        name,
        color: color ?? existing.color,
        lastSeen: now,
        alive: true,
      });
    }
    return null;
  },
});

export const leave = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const p = await ctx.db
      .query("players")
      .withIndex("by_session", (q: any) => q.eq("sessionId", sessionId))
      .unique();
    if (p) {
      await ctx.db.delete(p._id);
    }
    return null;
  },
});

export const heartbeat = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const p = await ctx.db
      .query("players")
      .withIndex("by_session", (q: any) => q.eq("sessionId", sessionId))
      .unique();
    if (p) await ctx.db.patch(p._id, { lastSeen: Date.now() });
    return null;
  },
});

export const setDirection = mutation({
  args: {
    sessionId: v.string(),
    dir: v.object({ x: v.number(), y: v.number() }),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, dir }) => {
    const p = await ctx.db
      .query("players")
      .withIndex("by_session", (q: any) => q.eq("sessionId", sessionId))
      .unique();
    if (!p || !p.alive) return null;
    // Prevent reversing into itself
    const cur = p.direction as Vec;
    if (cur.x + dir.x === 0 && cur.y + dir.y === 0) return null;
    await ctx.db.patch(p._id, { direction: dir });
    return null;
  },
});

export const tick = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const s = await getOrInitState(ctx);
    const now = Date.now();
    if (now - s.lastTickAt < s.tickMs - 5) return null; // too soon, skip

    // lock by updating lastTickAt first to avoid thundering herd
    await ctx.db
      .query("state")
      .withIndex("by_key", (q: any) => q.eq("key", GLOBAL_KEY))
      .unique();
    await ctx.db.patch(s._id, { lastTickAt: now });

    const players = await ctx.db.query("players").collect();
    const fruits = await ctx.db.query("fruits").collect();

    // Cleanup inactive players (fast cleanup to avoid duplicate lingering)
    for (const p of players) {
      if (now - p.lastSeen > 5_000) {
        await ctx.db.delete(p._id);
      }
    }

    // Ensure fruits count based on number of players (incremental only)
    const numPlayers = players.length;
    let desired = 1;
    if (numPlayers >= 1 && numPlayers <= 3) desired = 2;
    else if (numPlayers >= 4 && numPlayers <= 10) desired = 4;
    else if (numPlayers > 10) desired = 5;
    const maxCells = s.gridWidth * s.gridHeight;
    desired = Math.min(desired, maxCells);
    if (fruits.length < desired) {
      const toSpawn = desired - fruits.length;
      for (let i = 0; i < toSpawn; i++) {
        await ctx.db.insert("fruits", {
          x: randomInt(s.gridWidth),
          y: randomInt(s.gridHeight),
          spawnedAt: now,
        });
      }
    }

    // Ensure bots
    const aliveBots = (await ctx.db.query("players").collect()).filter((p: any) => p.isBot).length;
    const needBots = Math.max(0, s.targetBots - aliveBots);
    for (let i = 0; i < needBots; i++) {
      await ctx.runMutation(internal.game.spawnBot, {});
    }

    // Move snakes and resolve collisions
    const updatedPlayers = await ctx.db.query("players").collect();
    const fruitList = await ctx.db.query("fruits").collect();

    // Build occupied map of all segments for collision (before move)
    const occupied = new Map<string, string>(); // key "x,y" => sessionId
    for (const p of updatedPlayers) {
      if (!p.alive) continue;
      for (const seg of p.body as Array<Vec>) {
        occupied.set(`${seg.x},${seg.y}`, p.sessionId);
      }
    }

    for (const p of updatedPlayers) {
      if (!p.alive) continue;
      const body: Array<Vec> = p.body as Array<Vec>;
      const head = body[0];
      const dir = p.direction as Vec;
      const nHead = nextPos(head, dir, s.gridWidth, s.gridHeight);

      // Check self collision (moving into own body excluding tail which may move)
      const selfCollision = body.slice(0, body.length - 1).some((seg) => vecEq(seg, nHead));

      // Check collision with others
      const otherCollision = !selfCollision && occupied.has(`${nHead.x},${nHead.y}`) && !vecEq(nHead, body[body.length - 1]);

      if (selfCollision || otherCollision) {
        await ctx.db.patch(p._id, { alive: false, score: Math.max(0, p.score - 1) });
        continue;
      }

      // Check fruit
      let ate = false;
      for (const f of fruitList) {
        if (f && f.x === nHead.x && f.y === nHead.y) {
          await ctx.db.delete(f._id);
          ate = true;
          break;
        }
      }

      const newBody = [nHead, ...body];
      if (!ate) newBody.pop();

      await ctx.db.patch(p._id, {
        body: newBody,
        score: ate ? p.score + 1 : p.score,
      });

      // Simple bot AI: random turn occasionally
      if (p.isBot && Math.random() < 0.25) {
        const options: Vec[] = [
          { x: 1, y: 0 },
          { x: -1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: -1 },
        ].filter((d) => !(d.x + dir.x === 0 && d.y + dir.y === 0));
        await ctx.db.patch(p._id, { direction: options[randomInt(options.length)] });
      }
    }

    return null;
  },
});

export const spawnBot = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await getOrInitState(ctx);
    const sessionId = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const name = `Bot ${sessionId.slice(-3).toUpperCase()}`;
    const snake: Array<Vec> = [
      { x: randomInt(DEFAULTS.gridWidth), y: randomInt(DEFAULTS.gridHeight) },
    ];
    const dir = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }][randomInt(4)];
    await ctx.db.insert("players", {
      sessionId,
      name,
      color: randomColor(),
      body: snake,
      direction: dir,
      alive: true,
      isBot: true,
      score: 0,
      lastSeen: Date.now(),
    });
    return null;
  },
});

// Admin: Update state config (e.g., tickMs, grid size, fruit/bot targets)
export const adminSetConfig = mutation({
  args: {
    tickMs: v.optional(v.number()),
    gridWidth: v.optional(v.number()),
    gridHeight: v.optional(v.number()),
    maxFruits: v.optional(v.number()),
    targetBots: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await getOrInitState(ctx);
    const updates: any = {};
    if (args.tickMs !== undefined) updates.tickMs = Math.max(30, Math.floor(args.tickMs));
    if (args.gridWidth !== undefined) updates.gridWidth = Math.max(8, Math.floor(args.gridWidth));
    if (args.gridHeight !== undefined) updates.gridHeight = Math.max(8, Math.floor(args.gridHeight));
    if (args.maxFruits !== undefined) updates.maxFruits = Math.max(0, Math.floor(args.maxFruits));
    if (args.targetBots !== undefined) updates.targetBots = Math.max(0, Math.floor(args.targetBots));
    await ctx.db.patch(s._id, updates);
    return null;
  },
});

// Admin: Restart game for all players (keep them), reset snakes and scores, clear fruits
export const adminRestart = mutation({
  args: {
    tickMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { tickMs }) => {
    const s = await getOrInitState(ctx);
    const now = Date.now();
    if (tickMs !== undefined) {
      await ctx.db.patch(s._id, { tickMs: Math.max(30, Math.floor(tickMs)) });
    }
    // Clear fruits
    for await (const f of ctx.db.query("fruits")) {
      await ctx.db.delete(f._id);
    }
    // Reset players
    const players = await ctx.db.query("players").collect();
    for (const p of players) {
      const head = { x: randomInt(s.gridWidth), y: randomInt(s.gridHeight) };
      const dir = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }][randomInt(4)];
      await ctx.db.patch(p._id, {
        body: [head],
        direction: dir,
        alive: true,
        score: 0,
        lastSeen: now,
      });
    }
    await ctx.db.patch(s._id, { lastTickAt: now });
    return null;
  },
});

// Admin: Wipe all players and fruits; keep config (optionally set tick)
export const adminWipe = mutation({
  args: { tickMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { tickMs }) => {
    const s = await getOrInitState(ctx);
    for await (const p of ctx.db.query("players")) {
      await ctx.db.delete(p._id);
    }
    for await (const f of ctx.db.query("fruits")) {
      await ctx.db.delete(f._id);
    }
    const updates: any = { lastTickAt: Date.now() };
    if (tickMs !== undefined) updates.tickMs = Math.max(30, Math.floor(tickMs));
    await ctx.db.patch(s._id, updates);
    return null;
  },
});

export const internalLeave = internalMutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const p = await ctx.db
      .query("players")
      .withIndex("by_session", (q: any) => q.eq("sessionId", sessionId))
      .unique();
    if (p) await ctx.db.delete(p._id);
    return null;
  },
});


