// Integration fixture: no real Google credentials or network requests.
let transientFailures = 0;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "oauth2.googleapis.com") {
      const form = new URLSearchParams(await request.text());
      return Response.json({
        access_token:
          form.get("grant_type") === "refresh_token"
            ? "google-refreshed"
            : "google-access",
        expires_in: 3600,
        refresh_token: "google-refresh",
        scope:
          "https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly",
      });
    }
    if (url.hostname === "openidconnect.googleapis.com")
      return Response.json({
        sub: "user1",
        email: "student@example.com",
        email_verified: true,
      });
    if (
      url.hostname === "classroom.googleapis.com" &&
      url.pathname === "/v1/courses" &&
      url.searchParams.get("studentId") === "me"
    ) {
      if (
        url.searchParams.get("pageToken") === "transient-fixture" &&
        transientFailures++ === 0
      )
        return new Response("Temporary test failure", { status: 503 });
      return Response.json({ courses: [{ id: "c1", name: "Math" }] });
    }
    return new Response("Unexpected test upstream", { status: 500 });
  },
};
