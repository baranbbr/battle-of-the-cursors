import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Lightweight endpoint to remove a player on tab close via sendBeacon
http.route({
  path: "/leave",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return new Response("Bad Request", { status: 400 });
      }
      const { sessionId } = (await req.json()) as { sessionId?: string };
      if (!sessionId) return new Response("Bad Request", { status: 400 });
      await ctx.runMutation(internal.game.internalLeave, { sessionId });
      return new Response(null, { status: 204 });
    } catch (e) {
      return new Response("Server Error", { status: 500 });
    }
  }),
});

export default http;


