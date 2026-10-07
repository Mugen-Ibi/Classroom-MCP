// Test-only control surface; never included in production Worker or wrangler config.
import worker, { UnipaMonitor } from "../dist/index.js";
import { advanceFixtureClock } from "./worker-entry.js";
export default worker;
export class FixtureMonitor extends UnipaMonitor {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__advance_fixture") {
      const data = await this.ctx.storage.get("monitor:v1");
      advanceFixtureClock();
      await this.ctx.storage.put("monitor:v1", data);
      return new Response("fixture advanced");
    }
    return super.fetch(request);
  }
}
