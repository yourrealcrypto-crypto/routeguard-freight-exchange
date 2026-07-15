import { serve } from "@hono/node-server";
import app from "./app";
import { config } from "../config";

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(
      `RouteGuard Freight Exchange running at http://localhost:${info.port}`,
    );
    console.log(`Network: ${config.network}`);
    console.log("Live payments remain disabled by default.");
  },
);