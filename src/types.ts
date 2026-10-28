import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  ALLOWED_EMAILS?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export interface GoogleGrant {
  userId: string;
  email: string;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  googleScopes?: string[];
}

export type GoogleAccess = Omit<GoogleGrant, "refreshToken">;

export interface MaterialAttachment {
  driveFile?: {
    driveFile?: { id: string; title?: string; alternateLink?: string };
  };
  link?: { url: string; title?: string };
  youtubeVideo?: { id: string; title?: string; alternateLink?: string };
  form?: { formUrl: string; title?: string };
}

export interface CourseMaterial {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  state?: string;
  materials?: MaterialAttachment[];
  [key: string]: unknown;
}

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
  state?: string;
  materials?: MaterialAttachment[];
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
