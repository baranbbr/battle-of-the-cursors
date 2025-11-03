// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  players: defineTable({
    sessionId: v.string(),   // unique per tab/device
    name: v.string(),        // e.g. "Player-3F2"
    color: v.string(),       // UI color
    x: v.number(),
    y: v.number(),
    lastSeen: v.number(),    // Date.now()
  }).index("by_session", ["sessionId"]),

  bullets: defineTable({
    ownerSessionId: v.string(),
    x: v.number(),
    y: v.number(),
    vx: v.number(),
    vy: v.number(),
    createdAt: v.number(),
  }).index("by_owner", ["ownerSessionId"]),
});