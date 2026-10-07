# 重要未読・MCP Eventsのセキュリティ確認

2026-10-07。コード作成後の確認工程とfixture証拠。実接続・大学の利用条件・本番運用の承認を代替しない。独立した別担当によるレビューは、担当/委譲の確認待ち。

| 境界             | 実装・検証                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本人認可         | 既存OAuthのGoogle本人、ownerメール1件、`classroom:read`/`unipa:read`/`unipa:monitor`、resource、grant ID/expiryを確認。DOで再照合し配送直前も失効確認。旧grantにmonitor scopeを追加しない。               |
| 時間と回数       | UTC22/03/08のCron案、JST保守02–05を各HTTP前で拒否。10分遅延上限、旧Cronの再配達、日付跨ぎ、同枠失敗後の再試行を拒否するfixture。toolからcollectorを呼ばない。                                             |
| WAF・認証拒否    | 403/追加認証は停止、429/503はRetry-Afterと次枠の両方を尊重。本文POSTでの拒否も監視停止へ反映。迂回、連打、未読へ戻す操作はない。                                                                          |
| 本文の副作用     | 新規重大未読または本人が選んだ最大3件の予約のみ。一枠一本文。attemptingをPOST前に保存し、曖昧な中断後は再度開かない。readerは既読化の可能性を明示。                                                       |
| JSFとHTML        | 固定UNIPA origin/path、最新ViewState、同formの限定source、未知コマンドはPOST前停止、本文labelと件名等の照合。HTML script等をstrip、添付/リンク追跡なし。実DOMの一致は未検証。                             |
| callback SSRF    | 正確なhostname allowlist、HTTPS/443、userinfo/fragment/IP拒否。DoHの公開IPv4を検証し、そのIPへ固定、TLS元hostnameを検証。private/reserved/mixed DNSのmockで接続前拒否。redirectを追わない。               |
| 実行環境差       | workerdでredirect:errorが非対応なためmanual+3xx拒否。直接socketはCloudflare IP宛・IPv6-onlyに対応せずfail closed。別egress bindingを使う場合は、そのserviceも同じpinning条件の独立監査が必要。            |
| イベント/署名    | 署名challenge、一定時間内の再検証cache、24–64 byte whsec、exact bytesのHMAC-SHA256、stable event ID、rotation時の二重署名、response上限。別の暗号実装/node:cryptoで署名照合し、workerd mock受信側も検証。 |
| 配送状態         | 2xxとAI/本人通知完了は区別。410/401/403 pause、413/恒久4xx discard、429/5xx有限retry。認可失効・expiryを確認する。HTTP受理後に保存が失敗する場合の重複はevent IDで受信側も排除する必要がある。            |
| MCP 2026         | SDKのper-request envelopeとrouting headersを使用。独自events dispatcherもversionとmetadata、Mcp-Methodを照合し、不一致はDO操作前に拒否。unsubscribeは公式のname/arguments/delivery.urlで照合。            |
| 保存と秘密       | Cookie/ViewState/生HTMLを永続化しない。本文/一覧24時間、差分metadata30日。expiry alarmでbody/secret/ownerを削除し、cache readsも期限を強制。callback URL/secret/元例外をtool結果やログへ返さない。        |
| Prompt injection | 取得本文はuntrusted_source。server instructionsは大学本文を指示として扱わない。Classroom提出・返信・支払いの追加write toolはない。手動backfillは本人の選択IDだけを予約する。                              |
| 変更・稼働範囲   | separate worktree/branch。既存wranglerのbinding/trigger/secret設定は変更しない。deploy dry-runのみ。実UNIPA/実callback通信・新credential登録・resource provision・push/mergeなし。                        |

確認中に修正した点: legacy toolの追加取得経路、枠ごとの試行保存、本文の認証拒否がpauseに反映されない問題、購読解除の形式、期限cleanup alarm、callback検証cacheの延長による期限無制限化、workerd redirect指定、MCP 2026 fixtureのenvelope/routing headers。

残る制約: 件名等のmetadata由来IDであり、本文だけの訂正を検知できない。重要度は暫定候補ルールで誤判定/取りこぼしがある。初回baselineは過去通知を配信しない。複数重大通知の本文は一枠一件の予算で遅延/期限切れになり得る。OAuth KV失効の反映遅延、実WAF、実TLS callback到達性、CPU使用量、ChatGPTでの実トリアージ・利用者通知はfixtureでは保証できない。

稼働前には[構成・検証手順](UNIPA_IMPORTANT_EVENTS.md)と、この差分を別担当が確認する。本文既読化の許可は受領済みだが、deploy、DO/egress作成、実購読、実callback配送の許可はまだ受領していない。
