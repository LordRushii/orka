/**
 * Serves the Phase 4 browser fixture on two loopback origins.
 *
 * `docs/PHASE-4-BROWSER-CHECK.md` needs a real page, on a real origin, that the
 * extension can be pointed at -- and a *second* origin to prove that a
 * cross-origin step pauses for the user instead of continuing on its own.
 * Two ports on loopback give both without touching the network or requiring a
 * dependency: this is `Bun.serve` and nothing else.
 *
 * Run it with `bun run dev:fixtures`, then open
 * http://127.0.0.1:8788/phase4-page.html.
 */
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "apps", "extension", "test", "fixtures");
const ORIGIN_A = 8788;
const ORIGIN_B = 8789;

function serve(port: number): void {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname === "/" ? "/phase4-page.html" : url.pathname;
      // Only ever inside the fixtures directory, and only ever a file that is
      // there -- this is a dev helper, not a web server.
      if (path.includes("..")) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(FIXTURES, path));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: {
          "content-type": file.type.startsWith("text/") ? file.type : "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    },
  });
}

serve(ORIGIN_A);
serve(ORIGIN_B);
console.log(`Phase 4 fixture pages on http://127.0.0.1:${ORIGIN_A}/phase4-page.html`);
console.log(`Second origin (cross-origin checks) on http://127.0.0.1:${ORIGIN_B}/phase4-page.html`);
