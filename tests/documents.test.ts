import { describe, expect, it } from "vitest";
import { extractDocument, MAX_FILE_BYTES } from "../src/documents";
import { docxFixture, pdfFixture, pptxFixture } from "./document-fixtures";
import { strToU8, zipSync } from "fflate";

const docx =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pptx =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("Attachment document extraction", () => {
  it("extracts actual PDF text and identifies pages needing OCR", async () => {
    const result = await extractDocument(
      pdfFixture("PDF content", true),
      "application/pdf",
    );
    expect(result.text).toContain("[Page 1]\nPDF content");
    expect(result.text).toContain("[Page 2]");
    expect(result.warnings.join(" ")).toContain("pages: 2");
  });
  it("decodes Japanese PDF text through an embedded ToUnicode map", async () => {
    const result = await extractDocument(
      pdfFixture("AB", false, true),
      "application/pdf",
    );
    expect(result.text).toContain("講義");
  });
  it("preserves Japanese Word runs, entities and paragraph boundaries", async () => {
    const result = await extractDocument(docxFixture(), docx);
    expect(result.text).toContain("講義 & 資料\n");
    expect(result.text).toContain("表の項目");
    expect(result.warnings.join(" ")).toContain("main document body only");
  });
  it("uses presentation relationship order rather than slide file order", async () => {
    const result = await extractDocument(pptxFixture(), pptx);
    expect(result.text).toBe("[Slide 1]\nFirst slide\n\n[Slide 2]\nLast slide");
  });
  it("rejects DTDs, malformed XML and malformed PDF without fetching resources", async () => {
    await expect(
      extractDocument(
        docxFixture(
          '<!DOCTYPE doc [<!ENTITY x SYSTEM "https://private.test">]><doc>&x;</doc>',
        ),
        docx,
      ),
    ).rejects.toThrow();
    await expect(
      extractDocument(docxFixture("<doc><p></doc>"), docx),
    ).rejects.toThrow();
    await expect(
      extractDocument(strToU8("not a PDF"), "application/pdf"),
    ).rejects.toThrow();
  });
  it("limits actual ZIP expansion even when a local size declaration lies", async () => {
    const zip = zipSync({
      "word/document.xml": new Uint8Array(11 * 1024 * 1024).fill(97),
    });
    new DataView(zip.buffer).setUint32(22, 1, true);
    await expect(extractDocument(zip, docx)).rejects.toThrow(/limit/);
  });
  it("rejects missing slide relationships rather than returning a partial deck", async () => {
    const zip = zipSync({
      "ppt/presentation.xml": strToU8(
        '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldId r:id="missing"/></p:presentation>',
      ),
      "ppt/_rels/presentation.xml.rels": strToU8("<Relationships/>"),
    });
    await expect(extractDocument(zip, pptx)).rejects.toThrow("Missing slide");
  });
  it("rejects truncated ZIPs even when the main XML entry is complete", async () => {
    const bytes = docxFixture();
    await expect(
      extractDocument(bytes.slice(0, bytes.length - 22), docx),
    ).rejects.toThrow("ZIP");
  });
  it("rejects oversized files, text, invalid UTF-8 and cancelled extraction", async () => {
    await expect(
      extractDocument(new Uint8Array(MAX_FILE_BYTES + 1), "text/plain"),
    ).rejects.toThrow("File limit");
    await expect(
      extractDocument(new Uint8Array(500_001).fill(97), "text/plain"),
    ).rejects.toThrow("text limit");
    await expect(
      extractDocument(new Uint8Array([255]), "text/plain"),
    ).rejects.toThrow();
    await expect(
      extractDocument(docxFixture(), docx, AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
