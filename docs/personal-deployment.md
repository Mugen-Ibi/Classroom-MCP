# 個人デプロイガイド

自分のCloudflare Workerを作成し、自分のGoogleアカウントでClassroomを読む手順です。Google OAuthクライアント、Worker、KVは各自で用意します。作者のWorkerや資格情報を利用する必要はありません。

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
| `keep_vars`                         | `true`。Workers側で設定した実行時変数を保持   |
| `kv_namespaces`内の`OAUTH_KV`の`id` | 今作成したKVのID                              |

該当箇所は次の形になります。これは設定の抜粋です。ファイル全体を置き換えず、他の項目は保持してください。

```jsonc
"name": "classroom-mcp",
"keep_vars": true,
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "YOUR_KV_NAMESPACE_ID" }
]
```

元のファイルの作者用KV IDをそのまま使わないでください。`OAUTH_KV`というbinding名はコードが参照するため変更しません。Worker名を変えた場合はURLの先頭も合わせます。実際の公開URLはGitへ保存せず、初回デプロイ後にWorkers側で設定します。

チェック後、初回デプロイを行います。

```bash
npm run check
npm run deploy
```

初回デプロイ後、Dashboardの **Workers & Pages → 自分のWorker → Settings → Variables and Secrets** で、実行時変数`PUBLIC_URL`をWranglerが表示したWorkerのHTTPS URLに設定します。末尾にスラッシュを付けず、変更を反映してください。非機密のText変数として設定できます。実行時Secretとして管理することも可能です。GoogleのSecretsが未設定なので、この段階では`/health`と認可開始が503になるのが正常です。

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

Dashboardから設定する場合は、Workers & Pages → 自分のWorker → Settings → Variables & Secretsに**実行時Secret**として追加します。Workers Buildsのビルド専用変数ではありません。`.dev.vars`はローカル用で、本番Secretsの代わりにはなりません。

`wrangler.jsonc`にはWorker名・KVのbindingなどの非機密設定を保存し、Gitで管理してください。実行時変数はWorkers側で管理し、`keep_vars: true`を保持します。ファイル全体を除外すると、新しいcloneやWorkers Buildsで設定を読み込めなくなります。追跡済みファイルは`.gitignore`に追加しても追跡が続きます。認証情報のキーが混入した場合は`npm run check:config`がCI・ビルド・デプロイを停止します。

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

## 更新する

既存の Worker 名・PUBLIC_URL・OAUTH_KV の ID・Google OAuth 設定を維持してください。Classroom の読み取り権限と保存形式を維持する更新では既存接続を継続できます。クライアントが古いツール一覧を保持している場合は一覧を更新してください。実接続での継続は更新後に確認します。

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

競合があれば解消し、`wrangler.jsonc`のWorker名・KV IDが自分の設定のままで、`keep_vars: true`が維持されているか確認します。その後、チェックとデプロイを行います。

```bash
npm ci
npm run check
npm run deploy
git push origin main
```

通常のコード更新では同じKVとWorkerを継続使用します。`OAUTH_KV`を作り直すと既存接続が使えなくなり、再接続が必要です。Worker URLを変える場合は、`PUBLIC_URL`、GoogleのリダイレクトURI、MCPクライアントの接続先も変更します。

## 任意：GitHubから自動デプロイする

手動デプロイで接続確認ができた後、自分のWorkerにWorkers Buildsを設定できます。自分のForkを接続し、次を指定します。

| 項目               | 値                    |
| ------------------ | --------------------- |
| 本番ブランチ       | `main`                |
| ルートディレクトリ | `/`                   |
| ビルドコマンド     | `npm run check`       |
| デプロイコマンド   | `npx wrangler deploy` |
| ビルド環境変数     | `NODE_VERSION=24`     |

Cloudflare上のWorker名とForkの`wrangler.jsonc`の`name`を一致させます。Forkに自分のKV IDを保存し、`PUBLIC_URL`を含む実行時変数をWorker側に設定してから接続してください。`keep_vars: true`を維持し、GoogleのSecretsは引き続きWorkerの実行時Secretに設定します。

リポジトリにはPRとmainへのpushでチェックを行うGitHub Actionsもあります。これはWorkers Buildsとは別で、Workerのデプロイを行いません。Workers Buildsを使う構成では、GitHub側にCloudflare APIトークンを追加する必要はありません。

自動デプロイを有効にすると、Forkのmainへのpushが本番更新になります。

## 利用停止と認証の取り消し

一時的に接続を取り消す場合：

1. ChatGPTなどのMCPクライアントで接続を削除します。
2. [Googleアカウントの接続管理](https://myaccount.google.com/connections)で、このOAuthアプリへのアクセスを取り消します。

完全に廃止する場合は、上記に加えてCloudflareでWorkers BuildsのGit接続を解除し、個人用Workerと、そのWorker専用のKVを削除します。他のアプリと共有しているKVは削除しないでください。Google Cloud側でも、不要になった専用OAuthクライアントを削除します。

## 困ったとき

| 症状                                     | 確認・対応                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| KVが見つからない／初回デプロイに失敗する | 自分のCloudflareアカウントで作ったKV IDに置き換えたか、KV作成とデプロイ先が同じアカウントか |
| `Invalid host`                           | 実際のWorker URLと`PUBLIC_URL`が一致するか。末尾スラッシュなし                              |
| `redirect_uri_mismatch`                  | GoogleのリダイレクトURIが自分のWorker URL + `/callback`と完全一致するか                     |
| `access_denied`／接続を許可されない      | Googleのテストユーザー、`ALLOWED_EMAILS`、両方のClassroom読み取り権限、学校の管理者設定     |
| 7日後に認証が切れる                      | Google OAuthがExternal / Testingなら、MCPクライアントから再接続する                         |
| Google APIの403                          | Classroom APIが有効か、学生として授業に所属しているか、学校の管理者ポリシー                 |
| 授業一覧が空                             | 正しいGoogleアカウントで接続したか。既定ではACTIVEの学生向け授業のみ取得                    |
| `/health`が503                           | Workerの実行時変数に`PUBLIC_URL`、実行時SecretsにGoogleクライアントIDとシークレットがあるか |
| healthはokだが接続時に503                | Google資格情報の正しさ、`OAUTH_KV`のbindingとID、Worker設定                                 |
| 締切一覧が不完全                         | `warnings`を確認し、`courseId`を指定して再取得                                              |
| GitHubからのビルド失敗                   | Node.js 24以上、Worker名、KV ID、ビルド・デプロイコマンド                                   |

再認証する場合は、MCPクライアントから接続を開始し直してください。`/callback`を直接開いても接続できません。問い合わせにはSecret、トークン、認証URL、課題内容や学生の個人情報を貼らないでください。

ツールの詳しい動作・ページング・制限は[README](../README.md#mcpツール)、実装の制約と検証範囲は[ドキュメント案内](README.md)を参照してください。
