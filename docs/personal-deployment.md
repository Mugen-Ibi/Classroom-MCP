# 個人デプロイガイド

自分のCloudflare Workerを作成し、自分のGoogleアカウントでClassroomを読む手順です。Google OAuthクライアント、Worker、KVは各自で用意します。作者のWorkerや資格情報を利用する必要はありません。

更新日：2026-10-06。iUの学生向けUNIPA通知は任意で追加できます。Classroomの接続を確認してから「UNIPA通知を追加する」へ進んでください。[実装・検証記録](README.md)は導入手順と分けて参照できます。

## 事前に確認すること

- Node.js 24以上、npm、Gitをインストールしてください。
- Cloudflareアカウントと、Google Cloudでプロジェクト・OAuthクライアントを作成できるアカウントを用意してください。
- Classroomに学生として所属するGoogleアカウントを使います。教師向けの授業管理・提出物管理は対象外です。
- 学校アカウントで外部アプリが制限されている場合、学校管理者へ利用可否を確認してください。個人デプロイによってこの制限を回避できるわけではありません。
- ChatGPTを使う場合、カスタムMCP接続と開発者モードが利用できるか確認してください。表示や利用可否はプラン・ワークスペースの管理設定によって変わります。
- External / TestingのGoogle OAuthでは、この構成の更新トークンは7日で期限切れになり、再接続が必要です。
- Cloudflare Workers・KV、Google Cloudの料金と利用枠は各自のアカウントで確認してください。

このガイドではWorker名を`classroom-mcp`とします。URL例の`your-subdomain`は、自分のCloudflareのWorkersサブドメインに置き換えてください。

## 1. リポジトリを取得する

GitHub上でこのリポジトリを自分のアカウントへForkします。次の`YOUR_GITHUB_USER`を自分のGitHubユーザー名に置き換えます。

```bash
git clone https://github.com/YOUR_GITHUB_USER/Classroom-MCP.git
cd Classroom-MCP
npm ci
npx wrangler login
```

ブラウザーでCloudflareにログインし、デプロイ先のアカウントを選びます。複数アカウントがある場合は、後続のKV作成とWorkerデプロイを同じアカウントに対して行ってください。

Forkせず元のリポジトリをcloneして手動デプロイすることも可能ですが、設定変更を保存し更新を取り込むため、このガイドではForkを使います。

## 2. 自分のKVとWorker URLを設定する

Cloudflare DashboardのWorkers & Pagesで、自分のWorkersサブドメインを確認します。未設定なら画面の案内に従って設定してください。Worker名を`classroom-mcp`とする場合、URLは次の形式になります。

```text
https://classroom-mcp.your-subdomain.workers.dev
```

OAuth認証情報用のKVを作成します。

```bash
npx wrangler kv namespace create OAUTH_KV
```

表示されたKVのIDを控え、リポジトリの`wrangler.jsonc`を編集します。

| 項目                                | 設定内容                                      |
| ----------------------------------- | --------------------------------------------- |
| `name`                              | 自分のWorker名。このガイドでは`classroom-mcp` |
| `vars.PUBLIC_URL`                   | 自分のWorkerのHTTPS URL。末尾のスラッシュなし |
| `kv_namespaces`内の`OAUTH_KV`の`id` | 今作成したKVのID                              |

該当箇所は次の形になります。これは設定の抜粋です。ファイル全体を置き換えず、他の項目は保持してください。

```jsonc
"name": "classroom-mcp",
"vars": {
  "PUBLIC_URL": "https://classroom-mcp.your-subdomain.workers.dev"
},
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "YOUR_KV_NAMESPACE_ID" }
]
```

元のファイルの作者用URL・KV IDをそのまま使わないでください。`OAUTH_KV`というbinding名はコードが参照するため変更しません。Worker名を変えた場合はURLの先頭も合わせます。

チェック後、初回デプロイを行います。

```bash
npm run check
npm run deploy
```

Wranglerが表示したWorker URLと`PUBLIC_URL`が一致することを確認します。GoogleのSecretsが未設定なので、この段階では`/health`と認可開始が503になるのが正常です。URLが想定と異なった場合は`PUBLIC_URL`を修正し、再デプロイしてから先へ進んでください。

## 3. Google OAuthを設定する

1. [Google Cloud Console](https://console.cloud.google.com/)で、自分のプロジェクトを作成または選択します。
2. APIとサービス → ライブラリで、**Google Classroom API**を有効にします。
3. Google Auth Platformで、アプリ名・サポートメール・連絡先などのブランド情報を設定します。
4. Audience（対象）を設定します。個人用なら通常は**External / Testing**で開始し、Classroomで使う自分のGoogleアカウントをテストユーザーに追加します。組織のInternalを使う場合は、その組織の対象ユーザー・ポリシーに従います。
5. Data Access（データアクセス）に以下のスコープを追加します。
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
6. Clients（クライアント）で、**ウェブアプリケーション**型のOAuthクライアントを作成します。
7. 承認済みのリダイレクトURIに、**自分のWorker URL + `/callback`**を登録します。

```text
https://classroom-mcp.your-subdomain.workers.dev/callback
```

Google Cloudを設定したアカウントとClassroomの利用アカウントが違う場合、テストユーザーに登録するのはClassroomの利用アカウントです。後述の`ALLOWED_EMAILS`もそのアドレスにします。

このサーバー側OAuthフローでは、JavaScriptの承認済みオリジンは不要です。ローカルでGoogleログインも試す場合だけ、`http://localhost:8787/callback`を追加します。

Google Auth Platformでは`classroom.coursework.me.readonly`が同等の`classroom.student-submissions.me.readonly`として表示・保存される場合があります。実装はどちらも受け入れます。Googleログイン時は授業と自分の課題・提出状況の両方の読み取り権限を許可してください。

作成したOAuthクライアントのIDとシークレットを、次の手順でWorkerに設定します。MCPクライアント用に別のGoogle OAuthクライアントを作成する必要はありません。

## 4. WorkerのSecretsを設定する

リポジトリのディレクトリで実行します。各コマンドの入力欄へ値を貼り付けてください。

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAILS
```

| Secret                 | 入力する値                                |
| ---------------------- | ----------------------------------------- |
| `GOOGLE_CLIENT_ID`     | 手順3のOAuthクライアントID                |
| `GOOGLE_CLIENT_SECRET` | そのクライアントシークレット              |
| `ALLOWED_EMAILS`       | Classroomで使う自分のGoogleメールアドレス |

`ALLOWED_EMAILS`は実装上は任意ですが、個人用では本人のアドレスを設定してください。未設定または空の場合、Google OAuth側で認証可能な全ユーザーの接続を許可します。メールアドレスは完全一致で照合し、大文字・小文字は区別しません。

UNIPAを追加する場合は、この値を本人のGoogleメールアドレス**1件だけ**にします。Workerに保存した固定のUNIPA資格情報を他の学生と共有する構成は対象外です。

Dashboardから設定する場合は、Workers & Pages → 自分のWorker → Settings → Variables & Secretsに**実行時Secret**として追加します。Workers Buildsのビルド専用変数ではありません。`.dev.vars`はローカル用で、本番Secretsの代わりにはなりません。

`wrangler.jsonc`にはWorker名・URL・KVのbindingなどの非機密設定だけを保存し、Gitで管理してください。ファイル全体を除外すると、新しいcloneやWorkers Buildsで設定を読み込めなくなります。追跡済みファイルは`.gitignore`に追加しても追跡が続きます。認証情報のキーが混入した場合は`npm run check:config`がCI・ビルド・デプロイを停止します。

秘密情報をコミットした場合は、まず対象サービスでパスワード変更・資格情報の再発行を行い、新しい値をWorkerの実行時Secretsへ設定してください。履歴の書き換えだけでは漏えいした資格情報を無効化できません。GitHubのキャッシュやFork、既存cloneにも残り得るため、[GitHubの削除手順](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)も確認してください。

ブラウザーで自分のWorkerの`/health`を開きます。

```text
https://classroom-mcp.your-subdomain.workers.dev/health
```

HTTP 200で`status: ok`ならIDとシークレットが設定されています。このチェックは設定の有無のみを確認します。Googleの資格情報・KV・学校の許可が実際に使えるかは次の接続で確認します。

## 5. ChatGPTなどから接続する

ChatGPTでは、カスタムMCPアプリを追加できる設定画面で開発者モードを有効にし、以下で接続を作成します。

| 項目    | 値                                                     |
| ------- | ------------------------------------------------------ |
| MCP URL | `https://classroom-mcp.your-subdomain.workers.dev/mcp` |
| 認証    | OAuth                                                  |

1. MCPの接続許可画面で、接続を始めたクライアントと認証情報の返送先を確認します。
2. Googleログイン画面で、テストユーザーと`ALLOWED_EMAILS`に登録したアカウントを選びます。
3. Classroomの読み取り権限を許可します。
4. 接続後、以下のように依頼します。

```text
Classroomから自分が学生として所属する授業を取得してください。
```

授業が確認できたら、締切一覧も試します。

```text
Classroomから今週締切の課題を取得して、日本時間で締切順に並べて。
不完全な取得や、提出状況がUNKNOWNの課題はその旨を表示して。
```

Google Classroomの画面と照合し、本人の授業が取得できることを確認してください。教師としてのみ所属する授業は一覧の対象ではありません。添付資料はリンクのみで、Driveファイル本文は取得しません。

他のMCPクライアントも、OAuthとStreamable HTTPに対応していれば同じ`/mcp`を接続先にします。ブラウザーから直接リクエストするクライアントでは、実装の`src/index.ts`にある`allowedOriginHostnames`へのクライアントのホスト名追加が必要になる場合があります。

## 任意：iUのUNIPA通知を追加する

実装は`https://unipa.i-u.ac.jp`の通常Webログインと掲示一覧を対象にしています。他大学のUNIPAにURLだけを変更して使うことは想定していません。出席登録は学生自身が公式画面で行い、このMCPでは自動化しません。

1. 本人のCloudflareで通知専用KVを作ります。

   ```bash
   npx wrangler kv namespace create UNIPA_SNAPSHOTS
   ```

2. 表示されたIDを`wrangler.jsonc`へ追加します。既存の`OAUTH_KV`は保持します。

   ```jsonc
   "kv_namespaces": [
     { "binding": "OAUTH_KV", "id": "YOUR_OAUTH_KV_NAMESPACE_ID" },
     { "binding": "UNIPA_SNAPSHOTS", "id": "YOUR_UNIPA_KV_NAMESPACE_ID" }
   ]
   ```

3. 本人のWorkerへ`UNIPA_USER_ID`と`UNIPA_PASSWORD`を実行時Secretとして設定し、`ALLOWED_EMAILS`が本人のGoogleメール1件であることを確認します。

   ```bash
   npx wrangler secret put UNIPA_USER_ID
   npx wrangler secret put UNIPA_PASSWORD
   ```

   値は対話入力かDashboardへ直接入力します。ソース・`vars`・Git・チャットへ書かないでください。`.dev.vars`に設定した値は本番に反映されません。

4. `npm run check`を通し、専用KVを含む設定を`npm run deploy`で反映します。Workers Buildsを使っている場合は設定を自分のForkへ保存し、mainへpushしてデプロイ成功を確認します。
5. MCPクライアントから再接続し、接続許可画面に表示された追加読み取り権限`unipa:read`へ同意します。Googleへ要求するClassroomのスコープは変わりません。
6. `unipa_connection_status`で設定状態を確認し、`unipa_list_announcements`を1回だけ呼び、`complete: true`・件数・既読状態を公式の「全表示」と照合します。初回検証は直列で行います。

設定なしの接続はClassroomの5ツール、追加同意後はUNIPAを含む8ツールです。片方だけのSecretでも追加ツールは表示され得ますが、不完全な設定ではUNIPAへの通信を拒否します。状態ツールはログインを行わず、`configured: true`や`/health`の200だけではUNIPA認証成功を確認できません。

UNIPAは件名・カテゴリ・差出人・掲示日・未読状態・重要表示を返します。本文・添付・出席情報・既読更新・回答は取得しません。休講・教室変更は件名由来の候補で、授業名・対象日・時限・変更先は未確認です。掲示日を授業の対象日へ置き換えず、公式画面で確認してください。

通知は15分キャッシュ、最大24時間保存です。失敗時は最後の成功結果を`stale`として返すか、結果がなければエラーにします。`nextOffset`がある場合は同じフィルターで続きを取得します。[ツール・保存・制限の詳細](../README.md#unipa通知を追加する)を参照してください。

## 更新する

まず、変更した`wrangler.jsonc`を自分のForkへ保存します。URLとKV IDはSecretではありませんが、Googleクライアントシークレット、UNIPAのID・パスワード、トークン、`.dev.vars`はコミットしないでください。

```bash
git add wrangler.jsonc
git commit -m "Configure personal deployment"
git push origin main
```

元リポジトリの更新を取り込むには、初回にupstreamを追加します。

```bash
git remote add upstream https://github.com/Mugen-Ibi/Classroom-MCP.git
```

次回以降は、ローカルの変更をコミットしてから更新します。

```bash
git fetch upstream
git merge upstream/main
```

競合があれば解消し、`wrangler.jsonc`のWorker名・URL・KV IDが自分の設定のままか確認します。その後、チェックとデプロイを行います。

```bash
npm ci
npm run check
npm run deploy
git push origin main
```

通常のコード更新では同じKVとWorkerを継続使用します。`OAUTH_KV`を作り直すと既存接続が使えなくなり、再接続が必要です。Worker URLを変える場合は、`PUBLIC_URL`、GoogleのリダイレクトURI、MCPクライアントの接続先も変更します。

UNIPAを使っている場合は`UNIPA_SNAPSHOTS`のbindingとIDも維持します。UNIPAを含む追加同意がない既存接続は、更新後もClassroomの5ツールのままです。追加利用時に再接続してください。

## UNIPAの認証停止から再開する

`AUTH_REJECTED`または`INTERACTIVE_AUTH_REQUIRED`の場合、通知一覧の再呼び出しや時間経過だけでは自動ログインを再開しません。

1. 本人が[公式UNIPA](https://unipa.i-u.ac.jp/uprx/)で通常ログインし、パスワード・追加認証・アカウント状態を確認します。
2. 必要なら本人のWorkerのUNIPA Secretsを修正します。
3. Workerの非機密の実行時変数`UNIPA_AUTH_REVISION`を前回と異なる値へ変更します。既定は`1`なので、最初の再開なら例として`2`を使えます。英数字・`_`・`-`の1～64文字で、資格情報を含めません。
4. `wrangler.jsonc`の`vars`で管理する場合は、その値を保存して再デプロイします。Dashboardで設定する場合も次回デプロイする設定と一致させます。ビルド専用変数ではありません。
5. 状態を確認してから一覧取得を1回試し、公式一覧と照合します。認証失敗を繰り返すためにrevisionを変えないでください。

通信失敗・セッション失効・画面変更は最低5分、429/503は`Retry-After`以上の更新間隔があります。`retryAt`まで待ち、`stale`の結果は過去の成功として扱います。画面変更や件数不一致は、ログイン再開のためのrevision変更で解決するとは限りません。

## 任意：GitHubから自動デプロイする

手動デプロイで接続確認ができた後、自分のWorkerにWorkers Buildsを設定できます。自分のForkを接続し、次を指定します。

| 項目               | 値                    |
| ------------------ | --------------------- |
| 本番ブランチ       | `main`                |
| ルートディレクトリ | `/`                   |
| ビルドコマンド     | `npm run check`       |
| デプロイコマンド   | `npx wrangler deploy` |
| ビルド環境変数     | `NODE_VERSION=24`     |

Cloudflare上のWorker名とForkの`wrangler.jsonc`の`name`を一致させます。Forkに自分のURLとKV IDを保存してから接続してください。GoogleのSecretsは引き続きWorkerの実行時Secretに設定します。

リポジトリにはPRとmainへのpushでチェックを行うGitHub Actionsもあります。これはWorkers Buildsとは別で、Workerのデプロイを行いません。Workers Buildsを使う構成では、GitHub側にCloudflare APIトークンを追加する必要はありません。

自動デプロイを有効にすると、Forkのmainへのpushが本番更新になります。

## 利用停止と認証の取り消し

一時的に接続を取り消す場合：

1. ChatGPTなどのMCPクライアントで接続を削除します。
2. [Googleアカウントの接続管理](https://myaccount.google.com/connections)で、このOAuthアプリへのアクセスを取り消します。

完全に廃止する場合は、上記に加えてCloudflareでWorkers BuildsのGit接続を解除し、個人用Workerと、そのWorker専用のKVを削除します。他のアプリと共有しているKVは削除しないでください。Google Cloud側でも、不要になった専用OAuthクライアントを削除します。

### UNIPAだけを停止する

本人のWorkerから`UNIPA_USER_ID`と`UNIPA_PASSWORD`の**両方**のSecretを削除します。Wranglerを使う場合は、自分のWorkerを指す設定を確認してから実行します。

```bash
npx wrangler secret delete UNIPA_USER_ID
npx wrangler secret delete UNIPA_PASSWORD
```

その後、MCPのツール一覧を更新します。古い一覧が残るクライアントでは再接続してください。通知と認証停止状態も消したい場合は、そのWorker専用の`UNIPA_SNAPSHOTS`を削除し、bindingを`wrangler.jsonc`から除いて再デプロイします。通知データは通常最大24時間で失効しますが、認証停止理由にはTTLがありません。

Classroomを継続する場合は`OAUTH_KV`、Google関連のSecrets、`ALLOWED_EMAILS`を保持します。UNIPA Secretsの削除だけでMCP側の既存認可を取り消したことにはならないため、接続そのものも取り消す場合は上記のMCP・Googleの手順を使います。

MCPクライアント側の切断だけでGoogle側の許可も取り消されたとは限りません。Google側で許可を取り消しても、既に発行されたアクセストークンは即時無効にならない場合があります。サーバー側の利用を即時停止したい場合はWorkerも削除してください。MCPクライアントに既に渡った会話・データの削除は、そのサービス側で行います。

## 困ったとき

| 症状                                         | 確認・対応                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| KVが見つからない／初回デプロイに失敗する     | 自分のCloudflareアカウントで作ったKV IDに置き換えたか、KV作成とデプロイ先が同じアカウントか |
| `Invalid host`                               | 実際のWorker URLと`PUBLIC_URL`が一致するか。末尾スラッシュなし                              |
| `redirect_uri_mismatch`                      | GoogleのリダイレクトURIが自分のWorker URL + `/callback`と完全一致するか                     |
| `access_denied`／接続を許可されない          | Googleのテストユーザー、`ALLOWED_EMAILS`、両方のClassroom読み取り権限、学校の管理者設定     |
| 7日後に認証が切れる                          | Google OAuthがExternal / Testingなら、MCPクライアントから再接続する                         |
| Google APIの403                              | Classroom APIが有効か、学生として授業に所属しているか、学校の管理者ポリシー                 |
| 授業一覧が空                                 | 正しいGoogleアカウントで接続したか。既定ではACTIVEの学生向け授業のみ取得                    |
| `/health`が503                               | Workerの実行時SecretsにGoogleクライアントIDとシークレットがあるか                           |
| healthはokだが接続時に503                    | Google資格情報の正しさ、`OAUTH_KV`のbindingとID、Worker設定                                 |
| 締切一覧が不完全                             | `warnings`を確認し、`courseId`を指定して再取得                                              |
| GitHubからのビルド失敗                       | Node.js 24以上、Worker名、KV ID、ビルド・デプロイコマンド                                   |
| UNIPAツールが表示されない                    | UNIPA Secretsの有無、再接続での`unipa:read`への追加同意                                     |
| `OWNER_REQUIRED`                             | `ALLOWED_EMAILS`が本人のGoogleメール1件か、接続アカウントが一致するか                       |
| `CONFIG_REQUIRED`                            | 両UNIPA Secret、専用KV、`UNIPA_AUTH_REVISION`の形式                                         |
| `AUTH_REJECTED`／`INTERACTIVE_AUTH_REQUIRED` | 通常ログインとSecretsを本人が確認し、上記の認証再開手順へ                                   |
| `FORMAT_CHANGED`／`INCOMPLETE_LIST`          | 公式の一覧を確認。取得失敗を通知0件と判断せず、最後の成功日時と`stale`を確認                |
| `CACHE_UNAVAILABLE`                          | `UNIPA_SNAPSHOTS`のbinding・ID・利用状態                                                    |
| `UPDATE_PENDING`／`RATE_LIMITED`             | 同時呼び出しを止め、`retryAt`や更新間隔を確認して待つ                                       |

再認証する場合は、MCPクライアントから接続を開始し直してください。`/callback`を直接開いても接続できません。問い合わせにはSecret、トークン、認証URL、課題内容や学生の個人情報を貼らないでください。

ツールの詳しい動作・ページング・制限は[README](../README.md#mcpツール)、実装の制約と検証範囲は[ドキュメント案内](README.md)を参照してください。
