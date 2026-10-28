export const MCP_SCOPE = "classroom:read";
export const MATERIALS_SCOPE = "classroom:materials:read";
export const ATTACHMENTS_SCOPE = "classroom:attachments:read";
export const MCP_READ_SCOPES = [MCP_SCOPE, MATERIALS_SCOPE, ATTACHMENTS_SCOPE];
export const MATERIALS_GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly";
export const ATTACHMENTS_GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

// A legacy grant must never gain permissions just by refreshing its token.
export function permitsMcpScope(scope: string, googleScopes: string[] = []) {
  if (scope === MCP_SCOPE) return true;
  if (scope === MATERIALS_SCOPE)
    return googleScopes.includes(MATERIALS_GOOGLE_SCOPE);
  if (scope === ATTACHMENTS_SCOPE)
    return googleScopes.includes(ATTACHMENTS_GOOGLE_SCOPE);
  return false;
}
