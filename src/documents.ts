import { Unzip, UnzipInflate } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { getDocumentProxy } from "unpdf";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 500_000;
const MAX_PAGES = 100;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const layoutWarning =
  "Text extraction does not preserve visual layout, charts, equations or images. Verify these in the original file. OCR is not provided.";

function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
function checkText(text: string) {
  if (text.length > MAX_TEXT_CHARS) throw new Error("Document text limit");
}

// Stream only the XML needed for extraction. Limit actual expanded bytes, not
// just ZIP size declarations, and never execute macros or follow relationships.
function officeParts(bytes: Uint8Array, signal?: AbortSignal) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (
    end < 0 ||
    end < bytes.length - 65557 ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== view.getUint16(end + 10, true) ||
    view.getUint16(end + 10, true) > 2000 ||
    view.getUint32(end + 12, true) + view.getUint32(end + 16, true) !== end
  )
    throw new Error("Invalid or truncated ZIP directory");
  const expectedEntries = view.getUint16(end + 10, true);
  const parts = new Map<string, string>();
  const pending = new Set<string>();
  const names = new Set<string>();
  let expanded = 0;
  const unzip = new Unzip((file) => {
    if (names.has(file.name) || names.size >= 2000)
      throw new Error("Invalid ZIP entries");
    names.add(file.name);
    if (
      !/^(word\/document\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/slides\/[^/]+\.xml)$/.test(
        file.name,
      )
    )
      return;
    if ((file.originalSize ?? 0) > MAX_XML_BYTES) throw new Error("XML limit");
    pending.add(file.name);
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      expanded += data.byteLength;
      length += data.byteLength;
      if (expanded > MAX_XML_BYTES) throw new Error("Expanded XML limit");
      chunks.push(data);
      if (final) {
        const content = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          content.set(chunk, offset);
          offset += chunk.byteLength;
        }
        parts.set(file.name, textDecoder.decode(content));
        pending.delete(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small input chunks also bound expansion before the output callback runs.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    check(signal);
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
  }
  if (pending.size || names.size !== expectedEntries)
    throw new Error("Truncated ZIP");
  return parts;
}

type XmlNode = { [key: string]: XmlNode[] | string | Record<string, string> };
function parseXml(xml: string | undefined): XmlNode[] {
  if (
    !xml ||
    /<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new Error("Invalid XML");
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    maxNestedTags: 100,
  }).parse(xml) as XmlNode[];
}
function localName(name: string) {
  return name.split(":").at(-1);
}
function findNodes(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes)
    for (const [key, value] of Object.entries(node)) {
      if (localName(key) === name) found.push(node);
      else if (Array.isArray(value)) found.push(...findNodes(value, name));
    }
  return found;
}
function children(node: XmlNode) {
  return (
    Object.values(node).find((value): value is XmlNode[] =>
      Array.isArray(value),
    ) ?? []
  );
}
function xmlText(nodes: XmlNode[]): string {
  const output: string[] = [];
  let length = 0;
  const append = (text: string) => {
    length += text.length;
    if (length > MAX_TEXT_CHARS) throw new Error("Text limit");
    output.push(text);
  };
  const visit = (items: XmlNode[], inText = false) => {
    for (const node of items)
      for (const [key, value] of Object.entries(node)) {
        const name = localName(key);
        if (key === "#text" && inText && typeof value === "string")
          append(value);
        else if (Array.isArray(value) && name !== "del") {
          visit(value, name === "t");
          if (name === "p" || name === "br" || name === "tr") append("\n");
          if (name === "tab" || name === "tc") append("\t");
        }
      }
  };
  visit(nodes);
  return output.join("").trim();
}

function officeText(
  bytes: Uint8Array,
  presentation: boolean,
  signal?: AbortSignal,
) {
  const parts = officeParts(bytes, signal);
  if (!presentation) {
    const tree = parseXml(parts.get("word/document.xml"));
    const body = findNodes(tree, "body")[0];
    if (!body) throw new Error("Missing document body");
    return {
      text: xmlText(children(body)),
      warnings: [
        layoutWarning,
        "Word extraction includes the main document body only; headers, footers, comments and embedded objects are omitted.",
      ],
    };
  }
  const slides = findNodes(
    parseXml(parts.get("ppt/presentation.xml")),
    "sldId",
  );
  if (!slides.length || slides.length > MAX_PAGES)
    throw new Error("Slide limit");
  const relations = new Map<string, string>();
  for (const node of findNodes(
    parseXml(parts.get("ppt/_rels/presentation.xml.rels")),
    "Relationship",
  )) {
    const attr = node[":@"] as Record<string, string>;
    if (!attr?.["@_Type"]?.endsWith("/slide")) continue;
    if (
      attr["@_TargetMode"] === "External" ||
      !attr["@_Id"] ||
      !attr["@_Target"]
    )
      throw new Error("Invalid slide relationship");
    const url = new URL(attr["@_Target"], "https://ooxml.invalid/ppt/");
    if (
      url.origin !== "https://ooxml.invalid" ||
      !/^\/ppt\/slides\/[^/]+\.xml$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid slide path");
    relations.set(attr["@_Id"], url.pathname.slice(1));
  }
  const text = slides
    .map((node, index) => {
      check(signal);
      const attr = node[":@"] as Record<string, string>;
      const key = Object.keys(attr ?? {}).find((key) => /^@_.+:id$/.test(key));
      const part = key ? relations.get(attr[key]!) : undefined;
      if (!part) throw new Error("Missing slide");
      return `[Slide ${index + 1}]\n${xmlText(parseXml(parts.get(part)))}`;
    })
    .join("\n\n");
  checkText(text);
  return {
    text,
    warnings: [
      layoutWarning,
      "PowerPoint extraction follows presentation slide order; speaker notes and embedded objects are omitted.",
    ],
  };
}

export async function extractDocument(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
) {
  check(signal);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("File limit");
  if (mimeType.startsWith("text/")) {
    const text = textDecoder.decode(bytes);
    checkText(text);
    return { text, warnings: [] as string[] };
  }
  if (mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(bytes, {
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
      stopAtErrors: true,
      useWorkerFetch: false,
    });
    const abort = () => {
      void pdf.loadingTask.destroy().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (pdf.numPages > MAX_PAGES) throw new Error("Page limit");
      const pages: string[] = [];
      let length = 0;
      const emptyPages: number[] = [];
      for (let index = 1; index <= pdf.numPages; index++) {
        check(signal);
        const page = await pdf.getPage(index);
        const stream = page.streamTextContent();
        const reader = stream.getReader();
        const items: string[] = [];
        try {
          while (true) {
            check(signal);
            const { done, value } = await reader.read();
            if (done) break;
            for (const item of value.items)
              if ("str" in item) {
                const text = item.str + (item.hasEOL ? "\n" : " ");
                length += text.length;
                if (length > MAX_TEXT_CHARS) throw new Error("Text limit");
                items.push(text);
              }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          page.cleanup();
        }
        const text = items.join("").trim();
        if (!text) emptyPages.push(index);
        pages.push(`[Page ${index}]\n${text}`);
      }
      const text = pages.join("\n\n");
      checkText(text);
      return {
        text,
        warnings: [
          layoutWarning,
          ...(emptyPages.length
            ? [
                `No text found on PDF pages: ${emptyPages.join(", ")}. These pages may require OCR.`,
              ]
            : []),
        ],
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      await pdf.loadingTask.destroy();
    }
  }
  return officeText(bytes, mimeType.endsWith("presentation"), signal);
}
