// Synthetic workerd clock; production code never imports this entry.
import worker from "../dist/index.js";
const RealDate = Date;
let fixtureNow = RealDate.parse("2026-10-07T03:00:00Z");
export function advanceFixtureClock() {
  fixtureNow += 5 * 3600_000;
}
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(fixtureNow);
  }
  static now() {
    return fixtureNow;
  }
};
export default worker;
