# 公開版UNIPA Adapter：学生別デプロイとWorkers Secrets

更新日：2026-10-06（Asia/Tokyo）。各学生が自分のCloudflareへデプロイする方式を、利用者が指定した。ID／パスワードをWorkers Secretsへ保存する希望により、以前の「UNIPA資格情報はPCのメモリー内だけ」という保持条件を、この方式に限って更新する。ソースの公開と、各自の非公開Secret設定を分ける。

本書の設計に基づく通知Adapterと3ツールを実装し、`971807d`でmainへの公開・本番デプロイを確認した。合成データによるworkerd検証を含む79テストは成功。本人のSecretsによるCloudflareからのUNIPA認証は未検証で、公開確認時点の作者環境ではUNIPAが未設定だった。[実装の詳細](UNIPA_IMPLEMENTATION.md)、[学生の設定手順](personal-deployment.md#任意iuのunipa通知を追加する)、[確認記録](UNIPA_REVIEW_2026-10-06.md)を参照。

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

`UNIPA_USER_ID`／`UNIPA_PASSWORD`は実装で読み取る設定名。両Secretがなければ既存Classroom機能だけを提供する。いずれかがあれば追加同意の対象となるが、片方しかない設定は取得時にエラーとし、ログインを試みない。通知ツールの利用には再接続時の追加読み取り権限`unipa:read`への同意も必要。

現行では`ALLOWED_EMAILS`の省略時に複数利用者が各自のClassroomへ接続できる。しかし、Workerに固定したUNIPA資格情報はGoogleログインごとに切り替わらない。UNIPAの所有者制限が未設定／複数メール／本人と不一致なら`OWNER_REQUIRED`で通知の読み取り・ログインを拒否する。認証済みGoogleメールの完全一致を、資格情報の使用・キャッシュの読取より先に確認する。

専用KV `UNIPA_SNAPSHOTS`と非機密の実行時変数`UNIPA_AUTH_REVISION`も使う。revisionは既定`1`で、認証停止後に本人が通常ログインとSecretsを確認してから変更する。同意画面に示したMCP権限は暗号化されたトランザクションに固定し、承認POST時の設定変更によって追加権限を増やさない。Googleへ要求するスコープは変更しない。

ID／パスワードの値はGit、`wrangler.jsonc`の`vars`、公開README、MCPツール引数・結果、HTML、URL、ログへ含めない。Cookie、rx系状態、ViewStateも成果物やログへ出さない。

## Worker内の取得フロー

1. 現行MCP OAuth／Google認証と`unipa:read`の追加同意を確認する。
2. 所有者メール1件、本人の一致、両Secret、専用KV、revisionの形式を検証する。
3. 本人の通知キャッシュが15分以内なら返す。更新が必要なら停止理由と更新間隔を確認し、必要な場合だけログインする。
4. UNIPAの通常ログインフォームを取得し、実際のform actionと隠し状態を解析する。
5. Worker内でSecretのID／パスワードを同じUNIPAのHTTPSログイン先へ送信する。資格情報はURLへ含めず、POST本文をログへ出さない。
6. 取得処理専用のメモリー内Cookie jarで、認証後ポータル→掲示板→全表示→全件表示を処理する。応答のJSF XMLから状態を更新し、総件数と取得行数を照合する。
7. 件名・カテゴリ・差出人・掲示日等を正規化し、通知データだけをキャッシュへ保存して返す。

本学の内部APIは調査した入口でライセンス拒否だった。Secretsを設定しても、この制限が解除されるわけではない。通常WebログインとHTTP／JSF解析を使う。

ブラウザ自動化基盤は初期構成に含めない。Workerの通常`fetch`だけでUNIPAのCookieが自動維持されると仮定せず、Set-Cookie、CookieのPath／Secure／失効、リダイレクトを扱うCookie jarを実装した。転送先は本学UNIPAの確認済みoriginへ限定する。

## セッション、キャッシュ、エラー

初回PoCは単一の取得処理内でログインから一覧取得まで実行し、Cookieとフォーム状態をメモリー内だけで使う。Workerのメモリーが次の呼出しにも残ることを前提にしない。Cookieの永続保存やDurable Objectsは、実測で必要になった場合に検討する。

通知キャッシュは専用KV `UNIPA_SNAPSHOTS`を使用する。既存OAuthのKVへ資格情報や掲示を混ぜない。資格情報はSecrets、通知はKV、Cookie／フォーム状態はメモリーと用途を分ける。前案のPC→Worker同期入口は実装していない。

更新は利用者要求時に行い、鮮度15分・通知TTL24時間のキャッシュを使用する。常時巡回やCronはない。同一isolateの同時取得は集約し、KVへ120秒の更新中状態を残す。ただしKVは厳密な分散ロックではなく、複数isolateの同時ログインと停止状態の反映遅延は残る。初回の実機検証は直列で行う。

認証拒否とMFA／CAPTCHA等の追加認証を検出した時は自動再試行を止める。停止理由にTTLを設けず、本人が通常ログインとSecretsを確認してrevisionを変更するまで待つ。通知TTLとは別の状態である。取得中のセッション失効で同じ処理内の再ログインはせず、次の更新にも最低5分の間隔を置く。429/503は`Retry-After`以上待つ。ログインエラーを生のHTTP本文で返さず、資格情報を含まない理由コードと案内を返す。

完全な一覧を取得できなければ、最後の成功結果をstaleとして返すか明示的なエラーにする。失敗を通知0件として保存しない。本文は自動取得せず、休講・教室変更は件名由来の候補と未確認項目を示す。出席登録・出席収集、既読更新、掲示への回答は引き続き対象外。

## 実装した配置

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

`src/index.ts`、`src/mcp.ts`、`src/types.ts`は追加スコープとツール登録を受け入れ、`src/auth.ts`は追加同意を表示する。UNIPAのHTTP輸送・認証情報をClassroomのデータモデルやGoogle OAuth grantへ入れない。

## 学生の設定と検証の進め方

学生は自分のCloudflareの **Workers & Pages → 自分のWorker → Settings → Variables and Secrets** に、`UNIPA_USER_ID`、`UNIPA_PASSWORD`、本人1件の`ALLOWED_EMAILS`を**Secret**として直接入力する。ビルド時だけの変数ではなく、Workerの実行時Secretに設定する。チャットやGitHubへ値を送る必要はない。専用KVをバインドし、実装したWorkerをデプロイしてMCPアプリへ再接続する。本人のUNIPA Secretsの実登録と、設定後の取得検証は未実施。

実装・合成fixture・workerdでの認証と3ツール・所有者拒否・資格情報を返さないエラー処理・公開設定手順は完了した。実ページや本物の資格情報はfixtureへ保存していない。

残る実機検証は、本人がSecretsと専用KVを設定した環境で次の順に行う。

1. 状態ツールで設定を確認する。この呼び出しではUNIPAへログインしない。
2. 1回の通常HTTPログインと一覧取得を直列で試し、公式の全表示と件数を照合する。
3. CPU／時間制限、既読状態、本人の通常ログインへの影響を確認する。画面が違う場合や取得が不完全な場合は、成功キャッシュとして保存しない。
4. 必要な場合に停止・再開を確認する。複数isolateの同時利用は単一の検証が成立した後に評価する。

ブラウザ内の独立HTTP認証は前回成功したが、Cloudflareの送信元IPからの認証・取得は未検証。Secretsの保存・実行時利用は可能であり、直接取得までの成立はこのPoCで確認する。正式な自動取得の利用条件は大学・提供元への確認事項として残る。
