import { strToU8, zipSync } from "fflate";

export function pdfFixture(
  text = "Classroom fixture",
  blankPage = false,
  japanese = false,
) {
  const pages = blankPage ? "3 0 R 6 0 R" : "3 0 R";
  const content = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages}] /Count ${blankPage ? 2 : 1} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${japanese ? `/ToUnicode ${blankPage ? 7 : 6} 0 R` : ""} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...(blankPage
      ? [
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> >>",
        ]
      : []),
  ];
  if (japanese) {
    const cmap =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<41> <8B1B>\n<42> <7FA9>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
    objects.push(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(pdf);
}

export const wordXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>講義 &amp; </w:t></w:r><w:r><w:t>資料</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表の項目</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
export const docxFixture = (xml = wordXml) =>
  zipSync({ "word/document.xml": strToU8(xml) });
export function pptxFixture() {
  return zipSync({
    "ppt/presentation.xml": strToU8(
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="10" r:id="second"/><p:sldId id="11" r:id="first"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<Relationships><Relationship Id="first" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="x/slide" Target="slides/slide2.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:sld>',
    ),
    "ppt/slides/slide2.xml": strToU8(
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
    ),
  });
}
