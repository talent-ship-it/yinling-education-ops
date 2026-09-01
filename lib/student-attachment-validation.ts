export const MAX_STUDENT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export const STUDENT_ATTACHMENT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type StudentAttachmentContentType = (typeof STUDENT_ATTACHMENT_CONTENT_TYPES)[number];

export function isStudentAttachmentContentType(value: unknown): value is StudentAttachmentContentType {
  return typeof value === "string"
    && (STUDENT_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value.toLowerCase());
}

export function studentAttachmentKind(contentType: StudentAttachmentContentType) {
  return contentType === "application/pdf" ? "report" as const : "image" as const;
}

export function hasStudentAttachmentMagicBytes(
  contentType: StudentAttachmentContentType,
  bytes: Uint8Array,
) {
  if (contentType === "application/pdf") {
    return bytes.length >= 5
      && bytes[0] === 0x25
      && bytes[1] === 0x50
      && bytes[2] === 0x44
      && bytes[3] === 0x46
      && bytes[4] === 0x2d;
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  return bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

export function sanitiseStudentAttachmentName(value: string, fallback: string) {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .trim();
  const wellFormed = Array.from(normalized, (point) => {
    const codePoint = point.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : point;
  });
  const clean = wellFormed.slice(0, 180).join("");
  return clean || fallback;
}
