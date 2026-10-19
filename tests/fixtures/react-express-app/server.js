// Express API + static host for the built client. Data lives in a file inside the bundle (D14): no
// database, no outbound calls, nothing written at run time. Listens on $PORT (the node runtime sets it).
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const items = JSON.parse(readFileSync(join(here, "data", "items.json"), "utf8"));

app.get("/api/items", (_req, res) => res.json(items));

const dist = join(here, "dist");
if (existsSync(dist)) app.use(express.static(dist));

const port = Number(process.env.PORT ?? 3001);
// All interfaces by default: in the pod the readiness probe arrives over the pod network, not loopback.
// `npm run dev` sets HOST=127.0.0.1 so the laptop stays loopback-only.
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => console.log(`react-express-fixture on ${host}:${port}`));
