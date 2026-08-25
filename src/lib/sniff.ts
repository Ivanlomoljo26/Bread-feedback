/**
 * What a file actually IS, from its bytes.
 *
 * `File.type` is set by the browser, usually from the filename extension, and
 * a direct POST can set it to anything. Trusting it means the declared type
 * decides how the bytes are stored and served — which is the whole mechanism
 * behind "upload an HTML file called screenshot.png and get it served from our
 * origin". The bytes are the only thing an attacker cannot lie about.
 *
 * Deliberately tiny. Three formats, matching the allowlist and the form's
 * `accept` attribute exactly. A sniffer that recognises more types than the
 * service accepts is a way to accidentally start accepting them.
 *
 * One implementation, used by BOTH admission and the GitHub upload. It lives
 * in its own module because attachments.ts and publish.ts each need it and
 * already import from each other.
 */

export interface SniffedType {
  mime: 'image/png' | 'image/jpeg' | 'video/mp4';
  /** Name given to GitHub's upload endpoint, which needs one. */
  name: string;
  /** GitHub renders a video only from a bare URL; an image needs ![]() markup. */
  video: boolean;
}

/** Enough bytes for every signature below. `ftyp` sits at offset 4. */
export const SNIFF_BYTES = 12;

export function sniffType(bytes: Uint8Array): SniffedType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A. All eight bytes, not the first four: the
  // trailing CRLF/EOF sequence is what makes the signature hard to forge by
  // accident, and checking only "\x89PNG" would pass files that are not.
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: 'image/png', name: 'screenshot.png', video: false };
  }

  // JPEG: FF D8 FF. Covers JFIF, Exif and the rest — the fourth byte varies by
  // variant, so matching it would reject valid photographs.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', name: 'screenshot.jpg', video: false };
  }

  // ISO base-media (MP4, M4V, MOV): an "ftyp" box at offset 4. The leading
  // four bytes are the box length, so the marker is not at 0.
  if (bytes.length >= 8
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { mime: 'video/mp4', name: 'recording.mp4', video: true };
  }

  return null;
}
