# 公開版UNIPA Adapter：学生別デプロイとWorkers Secrets

更新日：2026-10-06（Asia/Tokyo）。各学生が自分のCloudflareへデプロイする方式を、利用者が指定した。ID／パスワードをWorkers Secretsへ保存する希望により、以前の「UNIPA資格情報はPCのメモリー内だけ」という保持条件を、この方式に限って更新する。ソースの公開と、各自の非公開Secret設定を分ける。

本書の設計に基づく通知Adapterと3ツールを実装した。合成データのworkerd検証は完了した。Worker本体の公開と、各自のSecrets・専用KVの設定後に行う実認証・取得の検証は別に扱う。本人のSecretsによるCloudflareからの認証は未検証。[実装の詳細](UNIPA_IMPLEMENTATION.md)と[学生の設定手順](../README.md#unipa通知を追加する)を参照。

## 決定

**学生1人につき本人のCloudflare Worker・本人のUNIPAアカウント1組とし、同じMCPに通知Adapterを追加する。WorkerがSecretsを使ってUNIPAへHTTPで自動ログインする。**

「自動入力」はWorker内で通常ログインのフォームPOSTを構成する意味とする。Secretsをブラウザ画面やMCPクライアントへ返して入力させない。通知データだけを本人のMCPへ返す。

既存のGoogle認証は維持する。保存したUNIPAアカウントとMCPに接続する本人を対応させ、他人のGoogleアカウントで当該UNIPAアカウントを利用できないようにする。

## 保存するもの

[Cloudflare公式のWorkers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)は、Workerに暗号化した値を設定し、実行時に`env`から利用する仕組み。設定後はDashboard／Wranglerに値を表示しない。Worker実行コードは値を利用できるため、アプリ側の出力・ログ抑制は引き続き必要になる。通常のSecretsはWorker単位であり、本件の学生別デプロイに合う。

| 設定名                  | 内容・条件                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `UNIPA_USER_ID`         | 本人のUNIPAログインID。各自のWorkerの実行時Secret                        |
| `UNIPA_PASSWORD`        | 本人のUNIPAパスワード。各自のWorkerの実行時Secret                        |
| `ALLOWED_EMAILS`        | 既存設定を使用。UNIPAを有効にする場合は本人のGoogleメール1件を必須にする |
| Google関連の既存Secrets | 現行READMEに従い各自が設定する。UNIPAのパスワードと混ぜない              |

`UNIPA_USER_ID`／`UNIPA_PASSWORD`は実装で読み取る設定名。両Secretがなければ既存Classroom機能だけを提供する。片方しかない設定はエラーとし、ログインを試みない。通知ツールの利用には再接続時の追加読み取り権限`unipa:read`への同意も必要。

現行では`ALLOWED_EMAILS`の省略時に複数利用者が各自のClassroomへ接続できる。しかし、Workerに固定したUNIPA資格情報はGoogleログインごとに切り替わらない。UNIPA有効時に所有者制限が未設定／複数メールなら、UNIPA機能を有効化しない検証を実装する。認証済みGoogleメールの完全一致を、資格情報の使用・キャッシュの読取より先に確認する。

ID／パスワードの値はGit、`wrangler.jsonc`の`vars`、公開README、MCPツール引数・結果、HTML、URL、ログへ含めない。Cookie、rx系状態、ViewStateも成果物やログへ出さない。

## Worker内の取得フロー

1. 現行MCP OAuth／Google認証を通し、本人のアカウントであることを確認する。
2. 本人の通知キャッシュが新しければ、それを返す。UNIPAへ毎回ログインしない。
3. 更新が必要な場合に、Secretsの設定・所有者制限・更新間隔を検証する。
4. UNIPAの通常ログインフォームを取得し、実際のform actionと隠し状態を解析する。
5. Worker内でSecretのID／パスワードを同じUNIPAのHTTPSログイン先へ送信する。資格情報はURLへ含めず、POST本文をログへ出さない。
6. 取得処理専用のメモリー内Cookie jarで、認証後ポータル→掲示板→全表示→全件表示を処理する。応答のJSF XMLから状態を更新し、総件数と取得行数を照合する。
7. 件名・カテゴリ・差出人・掲示日等を正規化し、通知データだけをキャッシュへ保存して返す。

本学の内部APIは調査した入口でライセンス拒否だった。Secretsを設定しても、この制限が解除されるわけではない。通常WebログインとHTTP／JSF解析を使う。

ブラウザ自動化基盤を初期構成へ追加せず、まずWorkerのHTTP通信で成立するかを確認する。Workerの通常`fetch`だけでUNIPAのCookieが自動維持されると仮定せず、Set-Cookie、CookieのPath／Secure／失効、リダイレクトを扱うCookie jarを実装する。転送先は本学UNIPAの確認済みoriginへ限定する。

## セッション、キャッシュ、エラー

初回PoCは単一の取得処理内でログインから一覧取得まで実行し、Cookieとフォーム状態をメモリー内だけで使う。Workerのメモリーが次の呼出しにも残ることを前提にしない。Cookieの永続保存やDurable Objectsは、実測で必要になった場合に検討する。

通知キャッシュは専用KV `UNIPA_SNAPSHOTS`を候補にし、既存OAuthのKVへ資格情報や掲示を混ぜない。資格情報はSecrets、通知はKV、Cookie／フォーム状態はメモリーと用途を分ける。これにより前案のPC→Worker同期入口は不要になる。

更新はまず利用者要求時の15分程度のキャッシュを目安にする。常時巡回やCronはPoCに追加しない。初期の検証では呼出しを直列にし、実装時には複数isolateでの同時更新・複数ログインを評価する。KVだけで厳密な分散ロックが成立するとは扱わない。

パスワードの拒否、アカウントロック、MFA／CAPTCHA等を検出した時は自動再試行を止め、本人の対応待ちにする。取得中のセッション失効を通常の通信エラーと混同して、ログインを繰り返さない。ログインエラーを生のHTTP本文で返さず、資格情報を含まない理由コードと案内を返す。

完全な一覧を取得できなければ、最後の成功結果をstaleとして返すか明示的なエラーにする。失敗を通知0件として保存しない。本文は自動取得せず、休講・教室変更は件名由来の候補と未確認項目を示す。出席登録・出席収集、既読更新、掲示への回答は引き続き対象外。

## 実装する配置

ローカルcollectorを前提とした配置を、Worker内の取得モジュールへ置き換える。通知モデル・3ツール・同一MCPの方針は維持する。

```text
src/unipa/config.ts    # Secretの設定状態、本人1件の所有者制限
src/unipa/session.ts   # HTTPログイン、メモリー内Cookie jar、失効
src/unipa/jsf.ts       # form action、動的ID、ViewState、XML更新
src/unipa/notices.ts   # 掲示一覧の取得と総件数照合
src/unipa/changes.ts   # 件名由来の休講・教室変更候補
src/unipa/snapshot.ts  # 本人の通知キャッシュと鮮度
src/unipa/types.ts     # Notice／ChangeCandidate／ConnectionStatus
src/tools/unipa.ts     # 通知一覧、授業変更候補、接続状態
```

`src/index.ts`、`src/mcp.ts`、`src/types.ts`はこの追加を受け入れる最小限の変更にする。UNIPAのHTTP輸送・認証情報をClassroomのデータモデルやGoogle OAuth grantへ入れない。

## 学生の設定手順とPoCの順序

学生は自分のCloudflareの **Workers & Pages → 自分のWorker → Settings → Variables and Secrets** に、`UNIPA_USER_ID`、`UNIPA_PASSWORD`、本人1件の`ALLOWED_EMAILS`を**Secret**として直接入力する。ビルド時だけの変数ではなく、Workerの実行時Secretに設定する。チャットやGitHubへ値を送る必要はない。専用KVをバインドし、実装したWorkerをデプロイしてMCPアプリへ再接続する。本人のUNIPA Secretsの実登録と、設定後の取得検証は未実施。

PoCは以下の順序とする。

1. 合成fixtureでJSF解析、完全性、失効、未設定Secret、所有者不一致を検証する。資格情報の値や実ページをfixtureへ保存しない。
2. Cloudflareの検証用Workerに本人がSecretsを設定し、1回の通常HTTPログインと一覧取得を検証する。本番Google機能のデプロイと切り分ける。
3. Cloudflareからの接続、ライブラリ互換性、リダイレクト、認証、全件照合、同時ログインが本人の通常UNIPA利用へ与える影響を確認する。
4. 本文を開かない一覧取得で既読状態が変わらないことを確認し、通知キャッシュと3ツールを追加する。
5. 既存Classroom機能、本人以外のアクセス拒否、エラーに資格情報が混入しないことを検証し、公開READMEへ設定手順を掲載する。

ブラウザ内の独立HTTP認証は前回成功したが、Cloudflareの送信元IPからの認証・取得は未検証。Secretsの保存・実行時利用は可能であり、直接取得までの成立はこのPoCで確認する。正式な自動取得の利用条件は大学・提供元への確認事項として残る。
