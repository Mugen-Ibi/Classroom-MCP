export const UNIPA_ORIGIN = "https://unipa.i-u.ac.jp";
export const UNIPA_PORTAL = `${UNIPA_ORIGIN}/uprx/`;

export interface UnipaBindings {
  ALLOWED_EMAILS?: string;
  UNIPA_USER_ID?: string;
  UNIPA_PASSWORD?: string;
  UNIPA_AUTH_REVISION?: string;
  UNIPA_SNAPSHOTS?: KVNamespace;
  UNIPA_MONITOR?: DurableObjectNamespace;
  UNIPA_MONITOR_ENABLED?: string;
  UNIPA_BODY_ENABLED?: string;
  UNIPA_BACKFILL_ENABLED?: string;
  UNIPA_MONITOR_ALLOW_READ_STATE_CHANGE?: string;
  UNIPA_IMPORTANCE_POLICY?: string;
  UNIPA_EVENT_CALLBACK_HOSTS?: string;
  UNIPA_WEBHOOK_EGRESS?: Fetcher;
  UNIPA_EVENT_DIRECT_EGRESS?: "pinned_socket";
}
export interface UnipaOwner {
  userId: string;
  email: string;
}

export interface Notice {
  id: string;
  source: "unipa";
  title: string;
  category: string;
  sender: string;
  postedDate: string;
  unread: boolean | null;
  important: boolean;
  officialUrl: string;
}

export interface Snapshot {
  schemaVersion: 1;
  fetchedAt: string;
  totalCount: number;
  complete: true;
  notices: Notice[];
}

export type ErrorCode =
  | "CONFIG_REQUIRED"
  | "OWNER_REQUIRED"
  | "AUTH_REJECTED"
  | "INTERACTIVE_AUTH_REQUIRED"
  | "SESSION_EXPIRED"
  | "FORMAT_CHANGED"
  | "INCOMPLETE_LIST"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "CACHE_UNAVAILABLE"
  | "UPDATE_PENDING"
  | "MAINTENANCE_WINDOW"
  | "OUTSIDE_FETCH_WINDOW";

const messages: Record<ErrorCode, string> = {
  MAINTENANCE_WINDOW:
    "UNIPAの保守時間帯（日本時間02:00–05:00）のため通信を停止しています。キャッシュは参照できます。",
  OUTSIDE_FETCH_WINDOW:
    "UNIPA取得は日本時間07:00・12:00・17:00の枠に限定しています。キャッシュは参照できます。",
  CONFIG_REQUIRED: "UNIPAの両Secretと専用KVの設定を確認してください。",
  OWNER_REQUIRED: "UNIPAはALLOWED_EMAILSに指定した本人1名だけが利用できます。",
  AUTH_REJECTED:
    "UNIPAの認証が拒否されました。自動再試行を停止しています。本人が通常ログインとSecretsを確認してください。",
  INTERACTIVE_AUTH_REQUIRED:
    "UNIPAで本人の追加認証が必要です。自動再試行を停止しています。",
  SESSION_EXPIRED:
    "取得中にUNIPAのセッションが失効しました。再ログインの連続実行は行いません。",
  FORMAT_CHANGED:
    "UNIPAの画面形式を確認できません。公式画面を確認してください。",
  INCOMPLETE_LIST:
    "UNIPAの全件数と取得件数を照合できません。公式画面を確認してください。",
  NETWORK_ERROR: "UNIPAへ接続できません。時間をおいて再確認してください。",
  RATE_LIMITED:
    "UNIPAへの更新を一時停止しています。時間をおいて再確認してください。",
  CACHE_UNAVAILABLE:
    "UNIPAの通知キャッシュを利用できません。専用KVを確認してください。",
  UPDATE_PENDING:
    "UNIPAの更新は実行中、または更新間隔の制限中です。後ほど再確認してください。",
};

// Never propagate upstream bodies, URLs, Cookie values, or original exceptions.
export class UnipaError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryAfterSeconds = 300,
  ) {
    super(messages[code]);
    this.name = "UnipaError";
  }
}

export function safeError(error: unknown): UnipaError {
  return error instanceof UnipaError ? error : new UnipaError("NETWORK_ERROR");
}

export const permanentFailure = (code: ErrorCode) =>
  code === "AUTH_REJECTED" || code === "INTERACTIVE_AUTH_REQUIRED";
