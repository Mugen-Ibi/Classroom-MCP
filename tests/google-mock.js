// Integration fixture: no real Google credentials or network requests.
let transientFailures = 0;
function project(data, fields) {
  if (!fields) return data;
  const match = fields.match(/^nextPageToken,(\w+)\(([^)]+)\)$/);
  if (!match) throw new Error("Unexpected field mask");
  const [, collection, selection] = match;
  return {
    nextPageToken: data.nextPageToken,
    [collection]: data[collection].map((item) =>
      Object.fromEntries(
        selection
          .split(",")
          .filter((field) => field in item)
          .map((field) => [field, item[field]]),
      ),
    ),
  };
}
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
      return Response.json(
        project(
          { courses: [{ id: "c1", name: "Math", section: "A" }] },
          url.searchParams.get("fields"),
        ),
      );
    }
    if (
      url.hostname === "classroom.googleapis.com" &&
      url.pathname === "/v1/courses/c1/courseWork" &&
      url.searchParams.get("courseWorkStates") === "PUBLISHED"
    )
      return Response.json(
        project(
          {
            courseWork: [
              {
                id: "a",
                courseId: "c1",
                title: "Task",
                description: "Submit slides",
                dueDate: { year: 2026, month: 10, day: 2 },
                materials: [
                  {
                    link: {
                      url: "https://example.com/material",
                      title: "Material",
                    },
                  },
                ],
                maxPoints: 100,
              },
            ],
          },
          url.searchParams.get("fields"),
        ),
      );
    if (
      url.hostname === "classroom.googleapis.com" &&
      url.pathname === "/v1/courses/c1/courseWork/-/studentSubmissions" &&
      url.searchParams.get("userId") === "me"
    ) {
      if (url.searchParams.has("pageToken"))
        return new Response("Unnecessary history page", { status: 400 });
      return Response.json(
        project(
          {
            studentSubmissions: [
              {
                id: "s1",
                courseWorkId: "a",
                state: "CREATED",
                assignmentSubmission: {
                  attachments: [
                    {
                      driveFile: {
                        id: "file1",
                        title: "Slides.pdf",
                        alternateLink:
                          "https://drive.google.com/file/d/file1/view",
                      },
                    },
                  ],
                },
                submissionHistory: [{ stateHistory: { state: "CREATED" } }],
              },
            ],
            nextPageToken: "unrelated-history",
          },
          url.searchParams.get("fields"),
        ),
      );
    }
    return new Response("Unexpected test upstream", { status: 500 });
  },
};
