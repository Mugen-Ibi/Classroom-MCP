import { UnipaError, type UnipaBindings, type UnipaOwner } from "./types";
export const UNIPA_SCOPE = "unipa:read";

export const unipaEnabled = (env: UnipaBindings): boolean =>
  Boolean(env.UNIPA_USER_ID || env.UNIPA_PASSWORD);

export function unipaConfig(env: UnipaBindings, owner: UnipaOwner) {
  const emails = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  // This precedes access to the credentials and all UNIPA cache reads.
  if (
    emails.length !== 1 ||
    emails[0] !== owner.email.toLowerCase() ||
    !owner.userId
  )
    throw new UnipaError("OWNER_REQUIRED");
  if (!env.UNIPA_USER_ID || !env.UNIPA_PASSWORD || !env.UNIPA_SNAPSHOTS)
    throw new UnipaError("CONFIG_REQUIRED");
  const revision = env.UNIPA_AUTH_REVISION ?? "1";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(revision))
    throw new UnipaError("CONFIG_REQUIRED");
  return {
    userId: env.UNIPA_USER_ID,
    password: env.UNIPA_PASSWORD,
    kv: env.UNIPA_SNAPSHOTS,
    ownerId: owner.userId,
    revision,
  };
}
