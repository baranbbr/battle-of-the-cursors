// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  players: defineTable({
    sessionId: v.string(),   // unique per tab/device
    name: v.string(),        // e.g. "Alice"
    color: v.string(),       // UI color hex
    body: v.array(v.object({ x: v.number(), y: v.number() })), // head is index 0
    direction: v.object({ x: v.number(), y: v.number() }), // unit step
    alive: v.boolean(),
    isBot: v.boolean(),
    score: v.number(),
    lastSeen: v.number(),    // Date.now()
  }).index("by_session", ["sessionId"]),

  fruits: defineTable({
    x: v.number(),
    y: v.number(),
    spawnedAt: v.number(),
  }),

  state: defineTable({
    key: v.string(), // singleton "global"
    gridWidth: v.number(),
    gridHeight: v.number(),
    tickMs: v.number(),
    lastTickAt: v.number(),
    maxFruits: v.number(),
    targetBots: v.number(),
  }).index("by_key", ["key"]),
});