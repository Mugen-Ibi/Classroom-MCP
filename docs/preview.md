# Classroom Preview

`wrangler.jsonc` の `previews.OAUTH_KV` は、ユーザーが作成した preview 専用 namespace を参照します。本番の OAuth KV は維持し、production と preview の認可・token・client 登録を分けます。

合成 workerd fixture は設定ファイルからそれぞれの namespace ID を読み、独立したローカル保存先に割り当てます。preview から production の KV レコードが見えず、preview の書き込みが production に影響せず、production の access / refresh token が拒否され、production grant が変わらないことを検証します。実 KV・実 Google・実ログインにはアクセスしません。

PR の自動 preview build と実 OAuth 接続の確認は別です。実 preview の公開 URL が確定した後、その URL に一致する `PUBLIC_URL`、preview 用 OAuth Secrets、Google の許可 callback 登録が必要です。これらは今回の変更では設定せず、本番値をコピーしていません。認証設定が欠けた preview は 503 になり得ます。build が成功しても認証成功とは報告しません。

本番デプロイ・merge・Cloudflare Dashboard の変更・新しい OAuth grant の作成は、この preview 設定変更では行いません。
