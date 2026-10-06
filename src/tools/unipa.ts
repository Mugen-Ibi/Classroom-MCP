import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { UnipaService } from "../unipa/snapshot";
import { scheduleChanges } from "../unipa/changes";
import { safeError } from "../unipa/types";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const paging = {
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};
const result = async (load: () => Promise<unknown>) => {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await load()) }],
    };
  } catch (error) {
    const safe = safeError(error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ code: safe.code, message: safe.message }),
        },
      ],
    };
  }
};

export function registerUnipaTools(server: McpServer, service: UnipaService) {
  server.registerTool(
    "unipa_connection_status",
    {
      description:
        "本人専用UNIPAの設定、最終取得日時、鮮度、認証停止理由を確認します。このツールはログインを試みません。",
      inputSchema: {},
      annotations,
    },
    () => result(() => service.status()),
  );
  server.registerTool(
    "unipa_list_announcements",
    {
      description:
        "UNIPA掲示板の全表示一覧から件名・カテゴリ・差出人・掲示日・未読状態を取得します。本文、既読操作、出席情報は取得しません。15分キャッシュ。stale/warningsとnextOffsetを確認してください。掲示日を授業の実施日と解釈しないでください。",
      inputSchema: {
        ...paging,
        query: z.string().max(200).optional(),
        unreadOnly: z.boolean().default(false),
      },
      annotations,
    },
    (args) =>
      result(async () => {
        const { notices, ...metadata } = await service.list();
        const filtered = notices.filter(
          (n) =>
            (!args.unreadOnly || n.unread === true) &&
            (!args.query ||
              [n.title, n.category, n.sender].some((t) =>
                t.includes(args.query!),
              )),
        );
        return {
          ...metadata,
          notices: filtered.slice(args.offset, args.offset + args.limit),
          filteredCount: filtered.length,
          nextOffset:
            args.offset + args.limit < filtered.length
              ? args.offset + args.limit
              : null,
        };
      }),
  );
  server.registerTool(
    "unipa_list_schedule_changes",
    {
      description:
        "UNIPAの件名に休講／教室変更を含む候補を返します。本文を読まないため、授業名・対象日・時限・変更先は未確認です。候補0件でも変更なしとは断定できません。必ず公式画面で確認してください。",
      inputSchema: {
        ...paging,
        kind: z.enum(["cancellation", "room_change"]).optional(),
      },
      annotations,
    },
    (args) =>
      result(async () => {
        const { notices, ...metadata } = await service.list();
        const changes = scheduleChanges(notices).filter(
          (c) => !args.kind || c.kind === args.kind,
        );
        return {
          ...metadata,
          changes: changes.slice(args.offset, args.offset + args.limit),
          candidateCount: changes.length,
          nextOffset:
            args.offset + args.limit < changes.length
              ? args.offset + args.limit
              : null,
          warnings: [...metadata.warnings, "TITLE_ONLY_CHECK_OFFICIAL_PORTAL"],
        };
      }),
  );
}
