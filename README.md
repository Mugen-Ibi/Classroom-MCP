# Google Classroom Readonly MCP

Google Classroomの授業・公開済み課題・自分の提出状況を、ChatGPTなどのMCPクライアントから読み取るCloudflare Workerです。Googleログイン、MCP OAuth認可、Googleトークンの更新に対応しています。

```text
ChatGPT / MCPクライアント
  → MCP OAuth（クライアントごとの接続許可）
  → Cloudflare Workers /mcp（Streamable HTTP）
  → Google OAuth → Google Classroom API（読み取り専用）
```

SDK v2のstateless MCPを使います。Durable Objectsは不要です。認証情報はWorkers OAuth ProviderがKV内に暗号化して保存します。課題の作成・提出・編集は実装していません。各接続はログインした本人のGoogleアカウントを使います。

## MCPツール

| ツール                 | 内容                                          |
| ---------------------- | --------------------------------------------- |
| `list_courses`         | 自分が学生として所属する授業。既定はACTIVE    |
| `list_assignments`     | 指定授業の公開済み課題。締切範囲を指定可能    |
| `get_assignment`       | 課題の説明・締切・添付資料へのリンク          |
| `list_my_submissions`  | 自分の提出状況。課題ID省略で授業内の全課題    |
| `list_due_assignments` | 授業をまたぐ締切と提出状況。既定は今から7日間 |

`list_due_assignments`は既定で`TURNED_IN`と`RETURNED`を除外します。返却済み課題を再確認したい場合は`pendingOnly: false`を指定してください。取得できない提出状態は`UNKNOWN`であり、未提出と断定できません。期限超過分は`dueAfter`に過去の日時を指定して含めます。

日時入力は`2026-10-01T00:00:00+09:00`のようにタイムゾーンを含めます。開始は以上、終了は未満です。Googleの締切はUTCで、出力の`dueAt`もUTCです。日本時間への表示変換はクライアント側で行います。

一覧の`nextPageToken`がある間は、同じ条件で次ページも取得してください。締切フィルターで空のページが返っても次ページが残ることがあります。集約ツールは各一覧10ページ、合計100 APIリクエストまでです。権限エラー・上限到達時は`incomplete: true`と`warnings`を返します。全件取得できたか確認してから課題一覧を確定してください。

添付資料のURLは返しますが、Driveファイルの本文は読み取りません。本文の解析には別途Google Drive連携を使用してください。

## このリポジトリのデプロイ先

既存のCloudflare Workers Builds接続に合わせています。

| 項目                 | 設定                                                  |
| -------------------- | ----------------------------------------------------- |
| GitHub               | `Mugen-Ibi/Classroom-MCP`                             |
| 本番ブランチ         | `main`                                                |
| Worker名             | `classroom-mcp`                                       |
| ルートディレクトリ   | `/`                                                   |
| ビルドコマンド       | `npm run check`                                       |
| デプロイコマンド     | `npx wrangler deploy`                                 |
| ビルド環境変数       | `NODE_VERSION=24`                                     |
| MCP URL              | `https://classroom-mcp.ibimugen.workers.dev/mcp`      |
| Googleのコールバック | `https://classroom-mcp.ibimugen.workers.dev/callback` |

Workers Buildsが依存をインストールしてからチェックとデプロイを実行します。GitHub ActionsもPRとmainへのpushで同じチェックを実行します。デプロイはWorkers Buildsに任せるため、GitHub側のCloudflare APIトークンは不要です。GitHub Actionsの結果とWorkers Buildsは別系統なので、デプロイ前の検証はWorkers Buildsのビルドコマンドにも設定します。

認証用KV `classroom-mcp-oauth`は作成済みで、`wrangler.jsonc`の`OAUTH_KV`にIDを設定しています。別アカウントでは`npx wrangler kv namespace create OAUTH_KV`で作成し、表示されたIDへ置き換えてください。

`wrangler.jsonc`のWorker名はCloudflare上の名前と一致させます。別アカウントに導入する場合は`PUBLIC_URL`、KVのID、GoogleのコールバックURLも変更してください。

## 初回設定：Google Cloud

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成、または選択します。
2. **APIとサービス → ライブラリ**で**Google Classroom API**を有効にします。
3. **Google Auth Platform**でブランド情報（アプリ名、サポートメール、連絡先）を設定します。
4. **対象 / Audience**を設定します。個人のプロジェクトはExternalとTestingで始め、自分が使うGoogleアカウントをテストユーザーに追加します。学校アカウントの内部アプリを作成する場合は組織のポリシーに従います。
5. **データアクセス / Data Access**に以下のスコープを追加します。
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`（OAuthリクエストでは`email`を使用）
   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
6. **クライアント / Clients**で**ウェブアプリケーション**型のOAuthクライアントを作成します。
7. **承認済みのリダイレクトURI**に、次を完全一致で登録します。

   ```text
   https://classroom-mcp.ibimugen.workers.dev/callback
   ```

   ローカルでGoogleログインも試す場合は`http://localhost:8787/callback`も登録します。JavaScriptの承認済みオリジンはこのサーバー側OAuthフローには不要です。

8. クライアントIDとクライアントシークレットを、次のCloudflareのSecretsへ設定します。

Classroomの`classroom.coursework.me.readonly`は、自分の課題と提出状況の読み取りをカバーします。Google Auth Platformでは同等の`classroom.student-submissions.me.readonly`として表示・保存される場合があり、サーバーはどちらの権限名も受け入れます。教師用スコープや書き込みスコープは要求しません。Googleの同意画面で両方のClassroom読み取り権限を許可してください。

ExternalかつTestingのGoogle OAuthでは、この構成の更新トークンは7日で期限切れになるため、定期的に再接続が必要です。継続運用する場合はGoogleの公開・審査要件を確認してください。学校の管理者が外部アプリへのアクセスを制限している場合は、管理者の許可が必要です。

## 初回設定：CloudflareのSecrets

[Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages → classroom-mcp → Settings → Variables & Secrets**で、次の値を**Secret**として追加します。ビルド専用の変数ではなく、Workerの実行時Secretに設定してください。

| Secret                   | 値                                                   |
| ------------------------ | ---------------------------------------------------- |
| `GOOGLE_CLIENT_ID`       | Googleで作成したOAuthクライアントID                  |
| `GOOGLE_CLIENT_SECRET`   | そのクライアントシークレット                         |
| `ALLOWED_EMAILS`（任意） | 接続を許可するメールアドレス。カンマ区切りで完全一致 |

自分専用で使う場合は`ALLOWED_EMAILS`に自分のGoogleメールアドレスを設定してください。省略すると、Google OAuthアプリの対象ユーザーならそれぞれ自分のClassroomへ接続できます。既存接続にもメール許可リストを再確認します。

Wranglerで設定する場合：

```bash
npx wrangler login
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAILS
```

GoogleのSecret、アクセストークン、更新トークンをGitHubやチャットに貼る必要はありません。OAuthの暗号化はライブラリが処理するため、追加のCOOKIE_ENCRYPTION_KEYは不要です。KVはOAuthクライアント、認可状態、暗号化されたGoogle認証情報を保存します。KVを削除すると全クライアントが再接続を必要とします。

GoogleのSecretsが未設定でもWorkerはデプロイ可能ですが、`/health`と認可開始は503を返します。設定後に`/health`が200で`status: ok`になることを確認してください。このヘルスチェックは設定の有無のみを確認し、Google資格情報の有効性までは検証しません。

## ChatGPTから接続

カスタムMCPアプリを使用できるChatGPTの設定画面で開発者モードを有効にし、以下でアプリを追加します。表示名・利用可否はプランやワークスペースの管理設定によって異なります。

- MCP URL: `https://classroom-mcp.ibimugen.workers.dev/mcp`
- 認証: **OAuth**
- クライアントの接続許可画面で返送先を確認 → Googleアカウントでログイン → Classroomの読み取り権限を許可

ChatGPT側のGoogle OAuthクライアントIDを作成する必要はありません。ChatGPTのOAuth接続先はこのWorkerで、GoogleにはWorkerがOAuthクライアントとして接続します。MCP側はCIMDと動的クライアント登録の両方に対応しています。

接続後の例：

```text
Classroomから今週締切の課題を取得して、日本時間で締切順に並べて。
提出状況がUNKNOWNのものは、確認が必要な課題として区別して。
```

## ローカル開発と検証

Node.js 24以上を使用します。

```bash
npm ci
cp .dev.vars.example .dev.vars
# .dev.varsにローカル用Google OAuthのID・Secretを設定
npm run dev
```

PowerShellではコピーに`Copy-Item .dev.vars.example .dev.vars`を使用できます。ローカルの`PUBLIC_URL`は`http://localhost:8787`です。ローカルKVは`.wrangler/`に保存され、本番のKVとは別です。

```bash
npm run check      # 型チェック、Workerのdry-runビルド、テスト、整形確認
npm test           # dry-runビルドとテスト
npm run build      # デプロイせずdist/へビルド
npm run format     # 整形
```

テストは実際のworkerd上で、MCP OAuth認可→Google認証のモック→トークン交換→MCPツール呼び出し→更新を検証します。Googleへの実リクエストや本物の資格情報は使用しません。ブラウザーと実Googleアカウントでの最終接続確認は、Google CloudとSecretsの設定後に行います。

MCP Inspectorで確認する場合は`npx @modelcontextprotocol/inspector`を実行し、Streamable HTTPで`http://localhost:8787/mcp`に接続します。

## トラブルシューティング

| 症状                    | 確認する設定                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` | Googleに登録した`/callback`と`PUBLIC_URL`。末尾スラッシュの違いも確認             |
| `access_denied`         | Googleのテストユーザー、全Classroom読み取り権限、ALLOWED_EMAILS、学校の管理者設定 |
| Google APIの403         | Classroom APIが有効か、学生として所属しているか、OAuth権限と管理者ポリシー        |
| 7日後に認証が切れる     | GoogleのTesting状態。MCPを再接続                                                  |
| Workerの503             | 実行時Secrets、OAUTH_KVのバインディング、PUBLIC_URLの設定                         |
| GitHubからのビルド失敗  | Worker名一致、Node.js 24以上、ビルドコマンド、KV設定                              |
| 締切一覧が不完全        | `warnings`を確認し、courseIdを指定して再検索                                      |

ソースではOAuthコードやトークンをログへ出力しません。初期設定でWorkers Observabilityも無効にしています。運用でログを有効にする場合は、認証コールバックのURLやヘッダーを記録しない設定にしてください。

## 参照

- [Cloudflare MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Workers OAuth Provider: upstream sign-in](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Classroom API: studentSubmissions.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork.studentSubmissions/list)
- [Classroom API: CourseWorkのUTC締切](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork)
- [Google OAuthの更新トークン有効期限](https://developers.google.com/identity/protocols/oauth2#expiration)
- [ChatGPTの開発者モードとMCP](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
