# UNIPA通知Adapterの実装

更新日：2026-10-07（Asia/Tokyo）。学生ごとに本人のCloudflareへデプロイする方式。

通知Adapterと3ツールは実装・公開済みで、`971807d`のGitHub CIとWorkers Buildsは成功した。2026-10-06の本番確認時点の作者環境ではUNIPAが未設定のため、その記録に実資格情報による取得成功は含まない。[導入手順](personal-deployment.md#任意iuのunipa通知を追加する)と[レビュー・公開確認](UNIPA_REVIEW_2026-10-06.md)を参照。

## サーバーの境界

同じMCPの中に独立したUNIPAモジュールを配置する。UNIPA側はClassroomのクライアント・課題モデル・Googleトークンに依存せず、認証入口から本人のIDとメールだけを受け取る。GoogleトークンはUNIPAへ送らない。

MCPの入口はGoogle認証とトークン更新を共用するため、Google側の認証が失効するとUNIPAツールにも入れない。UNIPA自体の取得失敗は通知ツールのエラーまたはstaleとして返し、Classroomの取得処理に混ぜない。独立したモジュールであっても、独立した認証入口がある構成ではない。

| 案                   | 今回の評価                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| 同一MCPの独立Adapter | 採用。接続・デプロイは1組、コード・Secrets・通知KV・追加読み取り権限を分離できる                 |
| UNIPA専用MCP         | UNIPAだけを配布する場合や、異なる運用者が担当する場合に適する。今回は学生の接続・設定が2組になる |
| Aggregator MCP       | 現時点の2データ源には不要。認証・障害・デプロイ箇所を増やす                                      |

独立したサーバーへ移す場合は`src/unipa/`と`registerUnipaTools()`を移し、本人を認証する入口を用意する。現在は`classroom:read`を持つ既存接続へUNIPAを自動追加せず、再接続の同意画面で追加権限`unipa:read`を付与する。Google側の要求スコープは変わらない。

追加同意の表示とツール登録の候補は、いずれかのUNIPA Secretの存在で決まる。取得・キャッシュ参照は別途、本人メール1件・両Secret・専用KV・revisionを検証する。同意画面に示した権限は暗号化されたトランザクションへ固定し、承認POST時に再計算して増やさない。旧接続は5ツール、追加同意済み接続は8ツールとなる。

```text
src/unipa/config.ts    所有者1件・Secrets・専用KVの確認
src/unipa/session.ts   同一origin限定HTTP・Cookie jar・通信上限
src/unipa/jsf.ts       隠しフォーム状態・PrimeFaces設定・XML部分更新
src/unipa/notices.ts   通常ログイン→掲示板→全表示→全件数照合
src/unipa/changes.ts   件名由来の授業変更候補
src/unipa/snapshot.ts  成功キャッシュ・停止状態・同時更新の集約
src/unipa/types.ts     UNIPAだけの設定・本人情報・通知モデル
src/tools/unipa.ts     3ツール・ローカルフィルター・ページ分割
```

## 認証と一覧取得

`PUBLIC_URL`、`UNIPA_AUTH_REVISION`などの実行時変数と各種SecretsはWorkersのSettingsで管理する。`wrangler.jsonc`には実URL・資格情報を保存せず、`keep_vars: true`でデプロイ時の変数保持を指定する。`OAUTH_KV`と`UNIPA_SNAPSHOTS`のbinding・IDは設定ファイルで管理し、変数保持の対象とは分ける。ローカル開発はGit対象外の`.dev.vars`を使う。

Workerは実行時SecretsからログインIDとパスワードを取得する。先に単一の`ALLOWED_EMAILS`と認証済み本人メールを照合する。ログインフォームのaction、hidden fields、ViewStateを解析し、通常のフォームPOSTで本学UNIPAだけに送る。Cookieは`tough-cookie`のメモリー内jarを使い、Path、Secure、失効、リダイレクトを処理する。外部origin、URL内の資格情報、任意クエリーへの転送を拒否する。

掲示板の実際のメニュー設定、全表示タブ、すべて表示するボタンを解析する。動的操作IDを固定せず、操作マーカーと最新ViewStateを送る。`linkedom/worker`でHTMLを読み、JSF XMLは`fast-xml-parser`の構文検証後に解析する。応答中のJavaScriptは実行しない。ルート置換・ログイン画面・XML redirect/errorを以前のDOMより先に評価する。必要なデータ更新とViewState更新が確認できなければ停止する。

JSF XMLの更新順に依存しないよう、HTML置換を終えてから最新ViewStateを全フォームへ適用する。置換されたフォームに状態入力がなければhidden入力を追加する。空または競合する状態は成功扱いにしない。

総件数と取得行数が一致したときだけ成功とする。明示的0件は受け入れるが、件数が不明の空画面は失敗として扱う。タイトルリンク・既読操作を送信する経路はない。未読状態は「既読にする／未読にする」の一覧ラベルを読むだけとし、不明なら`null`を返す。

## モデルと保管

`Notice`は件名、カテゴリ、差出人、掲示日、未読状態、重要表示、公式入口URLを持つ。固定した業務IDが得られていないため、件名・カテゴリ・差出人・掲示日のSHA-256と同一内容の出現順でIDを作る。同じメタデータの掲示も個別に残す。IDは永続的な業務IDではなく、編集や重複行の順序変化に影響される。

休講／教室変更は件名由来の候補だけとする。授業名・対象日・時限・変更先教室は推測せず`null`とし、公式画面での確認を求める。Classroomの授業IDとの自動対応付けは行わない。

ツールの引数は次のとおり。絞り込みとページ分割は完全なsnapshotに対してローカルで行う。

| ツール                        | 引数と結果                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `unipa_connection_status`     | 引数なし。保存済み状態を返すだけで、ログインは試みない。`authenticated`は`null`                                            |
| `unipa_list_announcements`    | `offset`、`limit`、`query`、`unreadOnly`。`query`は件名・カテゴリ・差出人の部分一致。`filteredCount`は絞り込み後の件数     |
| `unipa_list_schedule_changes` | `offset`、`limit`、`kind`（`cancellation`／`room_change`）。`candidateCount`と`TITLE_ONLY_CHECK_OFFICIAL_PORTAL`警告を返す |

`offset`は0～1000、`limit`は1～100（既定50）。`nextOffset`が`null`になるまで同じフィルターで取得する。`totalCount`は元の掲示総件数で、表示ページの行数ではない。日付フィルターは実装していない。休講と教室変更の両方を含む1件の掲示は2種類の候補となるため、候補数を掲示件数と同一視しない。

`UNIPA_SNAPSHOTS`へschemaVersion、成功時刻、総件数、完全な通知一覧だけを1値に保存する。通知TTLは24時間、鮮度は15分。資格情報・Cookie・フォーム状態・生HTML/XML・本文は保存しない。キャッシュキーには本人IDとUNIPA ID、認証revisionのハッシュを使う。パスワードやそのハッシュは保存しない。

エラー理由と更新中状態は別キーに置く。[同じKVキーへ1秒以内に複数回書かない](https://developers.cloudflare.com/kv/api/write-key-value-pairs/#limits-to-kv-writes-to-the-same-key)構成とする。認証拒否／追加認証の停止理由にはTTLを設けず、本人によるrevision変更までログインを止める。通知データのTTLとは別であり、停止理由には資格情報や通知本文を含めない。

失敗は成功キャッシュを上書きしない。前回成功が24時間以内ならstaleと理由を付けて返し、なければ固定した日本語メッセージと理由コードを返す。元の例外、HTTP本文、ログインID、CookieをMCP結果へ出さない。

設定不足は`CONFIG_REQUIRED`、所有者不一致は`OWNER_REQUIRED`、キャッシュへのアクセス失敗は`CACHE_UNAVAILABLE`。これらはログインを試して修復する対象にしない。状態ツールの`configured: true`は設定確認、`lastSuccessAt`・`stale`・`reason`・`retryAt`は保存済み状態であり、現在のログイン可否を検証した結果ではない。

## 検証範囲と残る確認

`npm run check`で79テスト、型チェック、Workerのdry-run、整形を通過した。合成fixtureで動的ID、ViewState更新の順序と入力の欠落、15→38件、重複行、明示的0件、不完全な一覧、失効した200 HTML、ルート置換、壊れたXML、外部転送拒否、認証停止、キャッシュ鮮度、所有者拒否を検証した。実際のworkerdでもMCP OAuth→追加同意→UNIPA HTTP/JSF→通知保存→ツールのページ分割を検証した。本物の資格情報や大学の掲示をテストに使わない。

独立HTTPログインと一覧取得はブラウザ内の調査で成功しているが、新しい実装によるCloudflareの実送信元からの取得は未実施。本人による実行時Secretsと専用KVの設定後、1回の取得を公式全表示と照合し、既読状態・通常ログインへの影響・CPU／時間制限を確認する。

同一isolateの同時呼び出しは集約し、KVに120秒の更新中状態を残す。ただしKVは分散ロックではないため、複数isolateの競合と、認証停止状態が他拠点へ反映されるまでの遅延は残る。初期PoCは直列利用を前提とし、実測で必要ならDurable Objectへ取得の直列化だけを移す。Cookieの永続保存はこの実装には含めない。

本学の内部APIは調査した入口でライセンス拒否だったため採用していない。この結果はすべてのUNIPA製品・大学でAPIが使えないことを意味しない。将来正式なAPIが利用可能になれば、同じ通知モデルを保ってHTTP/JSF collectorを置き換えられる。
