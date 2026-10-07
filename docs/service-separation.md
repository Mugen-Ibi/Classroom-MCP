# サービス分離と移行

2026-10-07 時点のローカル実装です。Classroom の既存 `main` を基点に、一覧機能を含む UNIPA のコード・依存・設定・テスト・運用文書を外しました。監視機能を含む PR #2 のブランチは変更していません。公開・PR 更新・merge・Cloudflare の変更はまだ実施していません。

## Classroom の既存接続

既存の Worker 名、公開 URL、`OAUTH_KV` の ID、Google OAuth クライアントと callback URL を維持します。新しい `OAUTH_KV` への入れ替えや古い認可の削除は行いません。Classroom の Google 読み取り権限と OAuth Provider の保存形式も維持します。

合成 KV に旧構成の `unipa:read` / `unipa:monitor` を含む grant を置き、既存の refresh token で更新し、Classroom の 5 ツールへ接続できることを workerd で検証しました。移行後は UNIPA ツールが表示されないため、クライアントが古いツール一覧を保持している場合は一覧更新が必要です。実アカウントでの接続継続はデプロイ後の確認事項です。

`keep_vars: true` のため、コードを更新しても既存の Worker 設定や未使用の UNIPA Secrets は自動削除されません。UNIPA 通信コードはなく、これらの値は参照しません。旧 Secrets・通知 KV の削除は移行確認後に別途決めます。

## 独立した UNIPA サービス

別のローカル Git リポジトリ `UNIPA-MCP` にコードと合成 fixture を用意しました。既存の秘密値、認可データ、通知内容、旧 Git 履歴を移植していません。Worker 名は `unipa-mcp` を仮名とし、公開 URL と GitHub 公開先は未確定です。

UNIPA は別 URL・別 `OAUTH_KV`・別通知 KV・別監視 Durable Object を使います。Google へ要求するのは本人確認の `openid email` と offline access のみです。Classroom の授業・課題権限は要求しません。UNIPA 用 callback URL の登録と新規 MCP 接続への同意が必要です。旧 grant や購読を自動移植しません。

GitHub の公開先、Classroom 用 PR の扱い、新 Worker と保存先の作成、runtime Secrets の本人による設定、デプロイ、監視・本文取得の有効化は次の承認範囲です。本文取得は既読化する可能性があり、その承諾も分けて確認します。
