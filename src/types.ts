import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAILS?: string;
}

export interface GoogleGrant {
  userId: string;
  email: string;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

export type GoogleAccess = Omit<GoogleGrant, "refreshToken">;

export interface Course {
  id: string;
  name: string;
  courseState?: string;
  alternateLink?: string;
  [key: string]: unknown;
}

export interface Assignment {
  id: string;
  courseId: string;
  title: string;
  dueDate?: { year: number; month: number; day: number };
  dueTime?: {
    hours?: number;
    minutes?: number;
    seconds?: number;
    nanos?: number;
  };
  [key: string]: unknown;
}

export interface Submission {
  id: string;
  courseWorkId: string;
  userId?: string;
  state?: string;
  late?: boolean;
  [key: string]: unknown;
}
