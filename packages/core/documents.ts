import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { put, get, id, now } from "./db.js";
import type { Profile, Listing } from "./schemas.js";
import { encrypt, decrypt } from "./auth.js";
const dir = path.join(config.dataDir, "files");
mkdirSync(dir, { recursive: true, mode: 0o700 });
export function saveDocument(
  userId: string,
  name: string,
  mime: string,
  buffer: Buffer,
  kind = "upload",
) {
  const documentId = id();
  writeFileSync(
    path.join(dir, documentId),
    JSON.stringify(encrypt({ base64: buffer.toString("base64") })),
    { mode: 0o600 },
  );
  return put("document", documentId, userId, {
    name,
    mime,
    size: buffer.length,
    kind,
    createdAt: now(),
    encrypted: true,
  });
}
export function readDocument(documentId: string, userId: string) {
  const doc = get("document", documentId, userId);
  if (!doc) throw new Error("Document not found");
  return {
    ...doc,
    buffer: doc.encrypted
      ? Buffer.from(
          decrypt(JSON.parse(readFileSync(path.join(dir, documentId), "utf8")))
            .base64,
          "base64",
        )
      : readFileSync(path.join(dir, documentId)),
  };
}
export async function resumePdf(
  userId: string,
  profile: Profile,
  listing: Listing,
) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]),
    y = 790;
  const ascii = (s: string) =>
    s
      .replace(/[–—]/g, "-")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\x20-\x7e\n]/g, "");
  const line = (s: string, size = 11, isBold = false) => {
    for (const original of ascii(s).split("\n")) {
      let text = "";
      for (const word of original.split(" ")) {
        if (font.widthOfTextAtSize(`${text} ${word}`, size) > 490 && text) {
          if (y < 60) {
            page = pdf.addPage([595, 842]);
            y = 790;
          }
          page.drawText(text, {
            x: 50,
            y,
            size,
            font: isBold ? bold : font,
            color: rgb(0.12, 0.16, 0.22),
          });
          y -= size + 7;
          text = word;
        } else text = text ? `${text} ${word}` : word;
      }
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 790;
      }
      page.drawText(text, { x: 50, y, size, font: isBold ? bold : font });
      y -= size + 8;
    }
  };
  line(profile.name, 24, true);
  line(profile.headline, 12);
  line(`${profile.email}${profile.phone ? " | " + profile.phone : ""}`);
  line(Object.values(profile.links).filter(Boolean).join(" | "), 9);
  y -= 10;
  line("EDUCATION", 11, true);
  line(profile.education || "Education details not provided.");
  y -= 10;
  line("SKILLS", 11, true);
  const wanted = listing.skillsMust.map((s) => s.toLowerCase());
  line(
    [...profile.skills]
      .sort(
        (a, b) =>
          Number(wanted.includes(b.toLowerCase())) -
          Number(wanted.includes(a.toLowerCase())),
      )
      .join(", "),
  );
  y -= 10;
  line("PROJECTS", 11, true);
  for (const project of [...profile.projects].sort(
    (a, b) =>
      b.skills.filter((s) => wanted.includes(s.toLowerCase())).length -
      a.skills.filter((s) => wanted.includes(s.toLowerCase())).length,
  )) {
    line(project.name, 12, true);
    line(project.description);
    if (project.url) line(project.url, 9);
    y -= 8;
  }
  return saveDocument(
    userId,
    `${profile.name.replace(/\s+/g, "-")}-resume.pdf`,
    "application/pdf",
    Buffer.from(await pdf.save()),
    "tailored_resume",
  );
}
export async function coverLetterPdf(userId: string, text: string) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595, 842]),
    y = 790;
  const clean = text
    .replace(/[–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[^\x20-\x7e\n]/g, "");
  for (const paragraph of clean.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (font.widthOfTextAtSize(`${line} ${word}`, 11) > 490 && line) {
        if (y < 65) {
          page = pdf.addPage([595, 842]);
          y = 790;
        }
        page.drawText(line, { x: 50, y, size: 11, font });
        y -= 18;
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (y < 65) {
      page = pdf.addPage([595, 842]);
      y = 790;
    }
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 20;
  }
  return saveDocument(
    userId,
    "cover-letter.pdf",
    "application/pdf",
    Buffer.from(await pdf.save()),
    "cover_letter",
  );
}
