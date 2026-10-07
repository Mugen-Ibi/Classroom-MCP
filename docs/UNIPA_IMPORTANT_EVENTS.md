# 重要未読の本文取得とMCP Events（ローカル実装）

2026-10-07の改修。実環境へのdeploy、Cron有効化、購読作成、callback送信は未実施。

## 取得の条件

- 時刻は **Asia/Tokyoの毎日07:00・12:00・17:00**。UTC Cron案は `0 3,8,22 * * *`。07:00の枠はUTCでは前日の22:00に当たる。
- Cron配達の遅延は各枠から10分未満まで許容する。それより遅い実行、前日・前枠の再配達、枠外のcatch-upは取得しない。
- Durable Objectが枠内の最初の試行をHTTP開始前に保存する。成功・失敗どちらでも同じ枠の再ログインをしない。
- **02:00以上05:00未満の日本時間は保守停止**。一覧、本文、redirect先を含む全UNIPA HTTPリクエストの直前でチェックする。保守帯や取得枠外に入った処理はそこで終了する。
- 一覧・状態・保存本文の通常toolはキャッシュ参照のみ。tool呼出しが追加のログインを起こすことはない。旧`unipa:read` grantも同じ制限を受ける。
- 401/403や追加認証は自動取得を停止。429/503は`Retry-After`と次の取得枠を両方満たすまで待つ。詳細ページでの拒否も停止・バックオフへ反映する。WAF/MFAを迂回しない。
- Webhook再送と保存期限のcleanupはUNIPA取得とは別。UNIPAを開かずに保存済みイベントを配送できる。cleanup alarmはログインしない。

「一日3回」は取得セッションの数。ログイン→掲示板→全件表示等の複数HTTPが必要で、HTTP総数が3という意味ではない。1セッションは最大30 requests・120秒。実WAFの許容条件を保証するものではない。

## 本文と候補判定

従来本文を除外した理由は、[既存の調査記録](UNIPA_WEBAPI_INVESTIGATION_2026-10-06.md)に、別Cookie jarで本文を開いてもサーバ側で既読化した実測があるため。未読数が28から27へ変化していた。今回、重要な未読の本文取得による既読化について利用者の承認が追加された。未読へ戻す操作は行わない。

一次判定は件名・カテゴリのみで、次を暫定的な重大候補とする。実際の内容を断定しない。

| 対象 | 候補ルール                                                 |
| ---- | ---------------------------------------------------------- |
| 授業 | 休講、教室・時限・授業時間等の変更                         |
| 手続 | 期限を示す語と、提出・申請・登録・回答等の組合せ           |
| 支払 | 学費・授業料・納付等と、支払・期日・未納等の組合せ         |
| 安全 | アカウント・認証等と、停止・失効・侵害・対応依頼等の組合せ |
| 個別 | 本人・個人宛等と、提出・手続・至急・回答等の組合せ         |

`UNIPA_IMPORTANCE_POLICY`に`additionalCriticalTerms`と`excludedTerms`を設定できる。各配列最大50語、各語100文字。設定が壊れている場合は監視を有効化しない。一般広報・イベント等は通常候補とし、強い対応理由がある場合は除外語だけで打ち消さない。重要アイコンだけでは本文を開かずunknownとして残す。誤判定・取りこぼしはあり得るため、通常一覧とunknownの公式確認が必要。

`UNIPA_BODY_ENABLED=true`と`UNIPA_MONITOR_ALLOW_READ_STATE_CHANGE=true`の両方が必要。読み取り対象は取得時点で`unread === true`の重大候補のみ。未読不明、既読、通常候補は本文を取得しない。現行JSF readerは安全のため**取得枠につき本文一件**。一覧から選んだ実DOMの同一form・特定sourceのコマンドだけを構造解析し、サーバのJavaScriptは実行しない。未知コマンドはPOST前に停止する。

本文の件名・カテゴリ・差出人を一覧と照合し、本文欄だけをテキスト化する。script、iframe、form等を除去し、リンク・添付・画像を追加取得しない。最大16,000文字、過大な本文は切り捨てず取得失敗として返す。本文は`untrusted_source`であり、モデルへの指示や返信・提出・支払いの許可ではない。

本文取得状態、UNIPAでの既読、Webhook受理、AI判定、本人への通知完了は別状態。本文の失敗を「確認済み」と扱わない。本文POST前に`attempting`を保存し、途中終了した場合は`uncertain_after_interrupted_read`にして自動で再び開かない。

## 差分と既存未読

初回の完全な一覧はbaselineにする。既存通知の大量イベント送信・一括本文取得はしない。次回以降、新たに見つかった重要未読のID/versionを保存してから本文を取得し、準備が完了したイベントを配送する。本文失敗・無効設定等も明示的な状態としてキャッシュ読取に残る。複数重要通知がある場合、本文一件という予算で順次処理し、期限切れになる場合がある。

件名・カテゴリ・差出人・掲示日のhashと同一行の出現番号をIDに使う。大学の永続business IDではなく、`identityQuality: metadata_derived`と明示する。同じ内容の繰返し取得、読状態の変化、消失後の再出現は重複イベントにしない。件名等の訂正でIDが変わった場合は新しいidentityとして扱い、推測で古い通知へ結び付けない。同じ件名等のまま本文だけが訂正された場合の検知はできない。

既存の重要未読は、任意設定`UNIPA_BACKFILL_ENABLED=true`で`unipa_prepare_important_backfill`を追加できる。

1. 通常一覧から本人が対象IDを選ぶ。最大3件、重複ID不可。
2. `mode: preview`（既定）で内容と対象を確認する。UNIPAへ通信しない。
3. 本人が選択したIDだけを`mode: queue`で予約する。重大・未読である保存済み一覧、本文取得設定、既読化許可、有効な本人の購読が必要。未処理の手動予約は合計3件まで。
4. 次の通常取得枠で一件ずつ、最新一覧で再確認して本文を取得する。消失・既読・重大対象外ならその状態を記録する。追加ログイン枠を作らない。
5. 返された`eventId`で`unipa_read_cached_important_notice`を読む。過去通知のWebhookは送信しない。24時間で期限切れとなる未処理予約は再選択が必要。

このローカル作業では実通知の対象選択・予約・取得を行っていない。初回実検証は本人が選んだ一件に限定する。

## GPTへの経路

UNIPA自体のWebhook提供は確認できていない。UNIPA→Workerは上記Cronによる差分検出、Worker→ChatGPTは署名HTTPS Webhookという構成。

[公式MCP Events](https://developers.openai.com/plugins/build/mcp-events)に従い、同じOAuth保護済み`/mcp`に`server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`を追加する。イベント名は`unipa.important_notice_detected`、引数は空object。protocolは`2026-07-28`。通常toolsは既存SDKのMCP 2026 per-request metadataを使用する。

追加scope `unipa:monitor`を**旧grantへ自動付与しない**。監視の構成後にMCPアプリを再認可し、本人が購読する必要がある。OAuth grantの本人、scope、resource、expiry、失効をDO側でも照合し、配送直前にも再確認する。OAuth KVの失効反映は基盤の結果整合性に依存する。

ChatGPTがcallback URLと`whsec_`署名secretを供給する。本実装がsecretを生成・外部登録する処理はない。購読は本人・URL・event・引数から決定したidで更新し、最大4件、既定24時間で失効する。`ttlMs: null`でも有限のexpiryを返す。署名secret更新は5分間の二重署名に対応する。署名済みchallengeを確認してから保存する。

Webhookには件名等の短いmetadataだけを入れ、本文は本人認可済みの読取toolで取得する。Standard WebhooksのHMAC-SHA256をexact serialized bytesに適用し、retry時もevent IDを維持する。2xxは受理だけを意味する。410/401/403は購読の配送停止、413や他の恒久的4xxは破棄、429/5xx/通信失敗は上限付き指数backoff。配送の進捗を保存する。アプリ側でAI判定や通知を自動実行した事実は未確認。

OpenAI API keyや推論API呼出しはこのWorkerに不要。ChatGPT Work/Cloud等の対応面と受信後のトリアージ指示、アプリ・タスク権限は別途確認する。Cloudflare DOの稼働・保存には既存KV構成とは別のリソース/費用条件がある。

## callback egress

`UNIPA_EVENT_CALLBACK_HOSTS`は正確な許可hostnameをカンマ区切りで設定する。wildcard、IP、HTTP、認証情報付きURL、別port、fragmentは拒否する。実callbackのホストは未確定で、推測したGPT受信口は作っていない。

最小構成案は`UNIPA_EVENT_DIRECT_EGRESS=pinned_socket`。固定DoH resolverからA recordsを取得し、private/loopback/link-local/CGNAT/予約IPv4等を拒否する。接続時に選んだ公開IPへTCP接続し、TLSは元のhostnameで検証する。HTTP redirectは追わず、response/header/bodyを制限する。DoHに通知・secretは送らない。

**WorkersのTCP socketはCloudflare IP宛をブロックする**ため、callbackが該当する場合はdirect adapterでは配信できない。IPv6-onlyも現実装では拒否する。この場合は同じIP pinning・TLS検証・redirect拒否を満たす監査済みegressを`UNIPA_WEBHOOK_EGRESS` service bindingへ用意する必要がある。その外部serviceのprovisionは行っていない。

単なる`fetch`や`global_fetch_strictly_public`へfallbackしない。Workersの`node:https`もfetchラッパーなので接続固定の代用品にしていない。Workers fetchの`redirect: error`非対応は、service binding/DoHのmanual modeと3xx拒否で処理する。[TCP制約](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[node:httpsの制約](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/)参照。

## 本番構成の案（未適用）

既存のWorker、OAuth KV、UNIPA用KV、資格情報の参照を再利用する。資格情報をworktreeへコピーしない。`wrangler.jsonc`はこの改修では変更していない。

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "UNIPA_MONITOR", "class_name": "UnipaMonitor" }],
  },
  "migrations": [
    { "tag": "unipa-monitor-v1", "new_sqlite_classes": ["UnipaMonitor"] },
  ],
  "triggers": { "crons": ["0 3,8,22 * * *"] },
  "vars": {
    "UNIPA_MONITOR_ENABLED": "true",
    "UNIPA_BODY_ENABLED": "true",
    "UNIPA_MONITOR_ALLOW_READ_STATE_CHANGE": "true",
    "UNIPA_EVENT_DIRECT_EGRESS": "pinned_socket",
    "UNIPA_EVENT_CALLBACK_HOSTS": "<実callbackの正確なhostname>",
    "UNIPA_BACKFILL_ENABLED": "false",
  },
}
```

これは既存設定へ**後で統合する案**。migration tagの既存履歴との整合、CPU予算、実callback DNS/TLS到達性を確認してから適用する。DO/追加egressの作成、実稼働・deploy、実購読・callback送信は別の承認が必要。古い配置のまま新版だけをdeployするとlegacy toolは既存キャッシュ参照のみになるため、監視構成と再認可を含めた移行計画が必要。

本文/一覧は最大24時間、差分・event metadataは最大30日。購読secretは購読期限まで、旧secretはrotation windowまで。DO alarmが期限切れを削除する。Cookie、ViewState、ログインフォーム、生HTML/XMLはDOにもKVにも保存しない。停止・削除中のサービスでは即時削除時刻を保証できないが、読取時の論理期限も強制する。

## 検証と残る作業

合成fixtureで候補/unknown、重複/読状態/訂正、baseline、本文strip/範囲/失敗、保守境界、UTC日付跨ぎ、Cron遅延/再配達、枠外tool、WAF拒否/Retry-After、購読更新/失効/失効認可、署名、callback制約、backfillを検証する。workerd/MiniflareでOAuth同意→scope→DO保存→通常HTTP/JSF fixture→本文→署名検証付きmock→キャッシュtoolを通す。テスト専用時計/control routeは`tests`配下にのみ置き、本番bundleへ含めない。

実DOMのdetailコマンド、Cloudflare実送信元からのUNIPA到達性・WAF影響、CPU使用量、ChatGPT callbackへの到達性、実受信後のAIトリアージ/本人通知は未検証。scope再認可と購読承認が必要。本文既読化の許可は受領済みで、未読へ戻す許可ではない。
