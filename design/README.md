# Classroom MCPのロゴ

組み込みimage_genで生成したオリジナルロゴです。Googleの公式ロゴではありません。配信用PNGは生成画像を縮小・圧縮して作成し、WorkerのJavaScriptに埋め込まず静的アセットとして配信します。

| ファイル                                               | 用途                             |
| ------------------------------------------------------ | -------------------------------- |
| [classroom-logo-source.png](classroom-logo-source.png) | 生成した元画像                   |
| [icon-512.png](../public/icon-512.png)                 | MCPの512pxアイコン               |
| [icon-128.png](../public/icon-128.png)                 | MCPの128pxアイコンとページ内表示 |
| [favicon.png](../public/favicon.png)                   | ブラウザーのfavicon              |

使用したプロンプト：

```text
Use case: logo-design. Asset: square app icon for a personal Google Classroom read-only MCP integration, an independent application, not an official Google product. Create a polished minimalist flat graphic: an emerald green rounded square containing one bold ivory calendar page whose lower-right corner forms a simple golden check mark. Dark emerald calendar binding tabs. Balanced geometric shapes, thick clear strokes, very few details, crisp edges, generous centered padding. Clear silhouette legible at 32 pixels. Front-facing 2D vector-like raster illustration. Full square canvas, solid light cream background outside the green rounded square. No text, no letters, no numbers, no gradients, no shadows, no official Google logos, no watermark.
```

MCPのserverInfoに128px・512pxアイコンのURLを登録しています。対応クライアントで表示できます。ホームページ・OAuth同意画面にもロゴとfaviconを設定しています。

個人デプロイではアイコンURLもWorkersのSettingsで設定した`PUBLIC_URL`を基に自分のWorkerへ向きます。実際の公開URLを`wrangler.jsonc`へ保存する必要はありません。2026-10-06の作者環境では3点の配信用PNGが200で返り、ソースのファイルとバイト一致したことを確認しています。[公開確認記録](../docs/UNIPA_REVIEW_2026-10-06.md)と[ドキュメント案内](../docs/README.md)を参照してください。
