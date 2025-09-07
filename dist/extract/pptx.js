import JSZip from "jszip";
function xmlToPlain(xml) {
    // Extract text nodes inside a:t tags (PowerPoint text runs)
    const matches = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map((m) => m[1]);
    const joined = matches.join(" ");
    // Basic entity decode and whitespace normalize
    return joined
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/&/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}
export async function extractPptxText(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    // Collect slide files
    const slideFiles = Object.keys(zip.files)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)\.xml/)?.[1] || 0);
        const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] || 0);
        return na - nb;
    });
    const slides = [];
    for (const f of slideFiles) {
        try {
            const xml = await zip.file(f).async("string");
            const text = xmlToPlain(xml);
            if (text)
                slides.push(text);
        }
        catch {
            // ignore broken slide
        }
    }
    return slides.join("\n\n").trim();
}
