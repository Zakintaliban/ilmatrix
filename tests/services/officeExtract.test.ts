import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractDocxText } from "../../src/extract/docx.js";
import { extractPptxText } from "../../src/extract/pptx.js";
import { BoundedZipReader, MAX_OFFICE_XML_BYTES, OfficeFileTooLargeError, decodeXmlEntities } from "../../src/extract/zip.js";

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

const docx = (body: string) => `<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`;
const slide = (text: string) => `<p:sld><a:t>${text}</a:t></p:sld>`;

test("DOCX and PPTX text is extracted with XML entities decoded", async () => {
  const d = await extractDocxText(await zipOf({ "word/document.xml": docx("Laba &amp; rugi: a &lt; b, &quot;kutip&quot; &#8212; selesai") }));
  assert.equal(d, 'Laba & rugi: a < b, "kutip" — selesai');

  const p = await extractPptxText(
    await zipOf({
      "ppt/slides/slide2.xml": slide("Slide dua"),
      "ppt/slides/slide1.xml": slide("x &lt; y &amp;&amp; &amp;lt;tag&amp;gt;"),
    })
  );
  assert.equal(p, "x < y && &lt;tag&gt;\n\nSlide dua");
});

test("a zip bomb DOCX is refused without inflating it", async () => {
  // 60 MB of XML compresses to well under 1 MB
  const bomb = await zipOf({ "word/document.xml": docx(" ".repeat(MAX_OFFICE_XML_BYTES + 10 * 1024 * 1024)) });
  assert.ok(bomb.length < 1024 * 1024, `bomb is ${bomb.length} bytes`);
  await assert.rejects(extractDocxText(bomb), OfficeFileTooLargeError);
});

test("the budget is per document across all parts (many medium slides)", async () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) files[`ppt/slides/slide${i}.xml`] = slide("z".repeat(300_000));
  const reader = await BoundedZipReader.open(await zipOf(files), 1_000_000);
  await reader.readText("ppt/slides/slide1.xml");
  await reader.readText("ppt/slides/slide2.xml");
  await reader.readText("ppt/slides/slide3.xml");
  await assert.rejects(reader.readText("ppt/slides/slide4.xml"), OfficeFileTooLargeError);
});

test("a broken slide is skipped, the rest is kept", async () => {
  const buffer = await zipOf({
    "ppt/slides/slide1.xml": slide("Masih terbaca"),
    "ppt/slides/slide2.xml": slide("Rusak ".repeat(200)),
  });
  // Corrupt the start of slide 2's compressed data (right after its local file header name)
  const name = Buffer.from("ppt/slides/slide2.xml");
  const at = buffer.indexOf(name) + name.length;
  buffer.fill(0xff, at, at + 6);
  assert.equal(await extractPptxText(buffer), "Masih terbaca");
});

test("decodeXmlEntities decodes &amp; last and ignores invalid code points", () => {
  assert.equal(decodeXmlEntities("&amp;lt; &#x41; &#0; &#99999999;"), "&lt; A  ");
});
