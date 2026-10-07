// Test-only control surface; never included in production Worker or wrangler config.
import worker, { UnipaMonitor } from "../dist/index.js";
import { advanceFixtureClock } from "./worker-entry.js";
export default worker;
export class FixtureMonitor extends UnipaMonitor {
  constructor(ctx, env) {
    // workerd alarms use wall time, while fixture Date is fixed in the past.
    // Keep real alarms far in the future and invoke the production handler
    // explicitly, preventing nondeterministic automatic retries in this test.
    const offset = 10 * 365 * 24 * 3600_000;
    const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
    const getAlarm = ctx.storage.getAlarm.bind(ctx.storage);
    ctx.storage.setAlarm = (time, options) =>
      setAlarm(Number(time) + offset, options);
    ctx.storage.getAlarm = async () => {
      const time = await getAlarm();
      return time === null ? null : time - offset;
    };
    super(ctx, env);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/__advance_retry_fixture") {
      advanceFixtureClock(31_000);
      return new Response("fixture retry clock advanced");
    }
    if (new URL(request.url).pathname === "/__alarm_fixture") {
      const before = await this.ctx.storage.getAlarm();
      await this.alarm();
      return Response.json({
        before,
        after: await this.ctx.storage.getAlarm(),
        now: Date.now(),
      });
    }
    if (new URL(request.url).pathname === "/__advance_fixture") {
      const data = await this.ctx.storage.get("monitor:v1");
      advanceFixtureClock();
      await this.ctx.storage.put("monitor:v1", data);
      return new Response("fixture advanced");
    }
    return super.fetch(request);
  }
}
