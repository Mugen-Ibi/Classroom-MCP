import { readFileSync } from "node:fs";

// Check before Wrangler runs: its build output can print values from vars.
// JSONC property names are quoted; secrets.required may list names safely.
const config = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
const bindings = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "UNIPA_USER_ID",
  "UNIPA_PASSWORD",
];
const found = bindings.filter((name) =>
  new RegExp(`"${name}"\\s*:`).test(config),
);

if (found.length) {
  console.error(
    `wrangler.jsonc に認証情報の設定があります: ${found.join(", ")}。値を削除し、Worker の実行時 Secrets またはローカルの .dev.vars に設定してください。`,
  );
  process.exitCode = 1;
} else {
  console.log("wrangler.jsonc: 認証情報の設定なし");
}
