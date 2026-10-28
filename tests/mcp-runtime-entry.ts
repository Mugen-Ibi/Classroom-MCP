// Runtime compatibility fixture: no OAuth provider, grant storage or real API calls.
import { ClassroomClient } from "../src/classroom";
import { createClassroomServer } from "../src/mcp";
import { createMcpHandler } from "../src/mcp-handler";
import { extractDocument } from "../src/documents";

const origin = "http://127.0.0.1:8787";
const handler = createMcpHandler(
  () =>
    createClassroomServer(new ClassroomClient("fixture-google-token"), origin),
  {
    route: "/mcp",
    allowedHostnames: ["127.0.0.1"],
    allowedOriginHostnames: ["127.0.0.1"],
  },
);
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/extract") {
      return Response.json(
        await extractDocument(
          new Uint8Array(await request.arrayBuffer()),
          request.headers.get("Content-Type")!,
        ),
      );
    }
    return handler(request, {
      token: "fixture-mcp-token",
      audience: origin + "/mcp",
      clientId: "fixture-client",
      scope: ["classroom:read"],
    });
  },
};
