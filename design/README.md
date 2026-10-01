# Classroom MCPのロゴ

組み込みimage_genで生成したオリジナルロゴです。元画像は`classroom-logo-source.png`、配信用は`../public/icon-512.png`、`icon-128.png`、`favicon.png`です。配信用PNGは生成画像を縮小・圧縮して作成し、WorkerのJavaScriptに埋め込まず静的アセットとして配信します。

使用したプロンプト：

```text
Use case: logo-design. Asset: square app icon for a personal Google Classroom read-only MCP integration, an independent application, not an official Google product. Create a polished minimalist flat graphic: an emerald green rounded square containing one bold ivory calendar page whose lower-right corner forms a simple golden check mark. Dark emerald calendar binding tabs. Balanced geometric shapes, thick clear strokes, very few details, crisp edges, generous centered padding. Clear silhouette legible at 32 pixels. Front-facing 2D vector-like raster illustration. Full square canvas, solid light cream background outside the green rounded square. No text, no letters, no numbers, no gradients, no shadows, no official Google logos, no watermark.
```

MCPのserverInfoに128px・512pxアイコンのURLを登録しています。対応クライアントで表示できます。ホームページ・OAuth同意画面にもロゴとfaviconを設定しています。
