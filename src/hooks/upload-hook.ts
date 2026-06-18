import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MessageWithParts } from './types';

// Debounce: only run cleanup every 10 minutes per directory
const lastCleanupByDir = new Map<string, number>();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

interface FilePart {
  type: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

// Any part that represents an uploaded file, regardless of mime type.
function isFilePart(p: FilePart): boolean {
  return p.type === 'file';
}

// True for image files (by mime or filename extension). Used to decide
// whether to strip the original bytes (image models may reject them) or
// keep them alongside the injected path text.
function isImageFile(p: FilePart): boolean {
  const mime = p.mime as string | undefined;
  if (mime?.startsWith('image/')) return true;
  const filename = p.filename as string | undefined;
  const name = p.name as string | undefined;
  const fileName = filename ?? name;
  if (
    fileName &&
    /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic)$/i.test(fileName)
  )
    return true;
  return false;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/octet-stream': '.bin',
  };
  return map[mime] ?? '.bin';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cleanupAllSessions(saveDir: string): void {
  const now = Date.now();
  const lastCleanup = lastCleanupByDir.get(saveDir) ?? 0;
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanupByDir.set(saveDir, now);

  const maxAge = 60 * 60 * 1000;
  const dirsToScan: string[] = [];

  // Collect saveDir itself (for non-session uploads) + all session subdirs
  try {
    for (const entry of readdirSync(saveDir, { withFileTypes: true })) {
      const fp = join(saveDir, entry.name);
      if (entry.isDirectory()) {
        dirsToScan.push(fp);
      } else {
        try {
          if (now - statSync(fp).mtimeMs > maxAge) unlinkSync(fp);
        } catch {}
      }
    }
  } catch {}

  for (const dir of dirsToScan) {
    try {
      let isEmpty = true;
      let allRemoved = true;
      for (const f of readdirSync(dir)) {
        isEmpty = false;
        const fp = join(dir, f);
        try {
          if (now - statSync(fp).mtimeMs > maxAge) {
            unlinkSync(fp);
          } else {
            allRemoved = false;
          }
        } catch {
          allRemoved = false;
        }
      }
      // Remove session subdirectory only if it had files and all were expired
      if (!isEmpty && allRemoved) {
        try {
          rmdirSync(dir);
        } catch {}
      }
    } catch {}
  }
}

function writeUniqueFile(
  dir: string,
  name: string,
  data: Buffer,
  log: (msg: string) => void,
): string | null {
  const ext = extname(name);
  const base = basename(name, ext) || name;
  let candidate = join(dir, name);
  if (existsSync(candidate)) {
    return candidate;
  }
  let counter = 0;

  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      writeFileSync(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        counter += 1;
        candidate = join(dir, `${base}-${counter}${ext}`);
        continue;
      }

      log(`[upload-hook] failed to save file: ${e}`);
      return null;
    }
  }

  log(
    `[upload-hook] failed to save file: max attempts (${MAX_ATTEMPTS}) reached`,
  );
  return null;
}

interface SavedFile {
  filename: string;
  diskPath: string;
  isImage: boolean;
}

// Resolve a single file part to a saved disk path (or null when we can't
// produce a usable path). Data URLs are decoded and written to disk; bare
// file paths are recorded as-is; http(s) URLs are skipped.
function saveFilePart(
  part: FilePart,
  targetDir: string,
  log: (msg: string) => void,
): SavedFile | null {
  const url = part.url as string | undefined;
  const filename =
    (part.filename as string | undefined) ?? (part.name as string | undefined);
  const isImage = isImageFile(part);

  if (!url) return null;

  const decoded = decodeDataUrl(url);
  if (decoded) {
    const hash = createHash('sha1')
      .update(decoded.data)
      .digest('hex')
      .slice(0, 8);
    const sanitizedFilename = filename ? sanitizeFilename(filename) : undefined;
    const baseName = sanitizedFilename
      ? sanitizedFilename.replace(/\.[^.]+$/, '') || 'upload'
      : 'upload';
    const ext = sanitizedFilename
      ? extname(sanitizedFilename) || extFromMime(decoded.mime)
      : extFromMime(decoded.mime);
    const name = `${baseName}-${hash}${ext}`;
    const filePath = writeUniqueFile(targetDir, name, decoded.data, log);
    if (!filePath) return null;
    return { filename: filename ?? name, diskPath: filePath, isImage };
  }

  // Not a data URL. Try to treat it as a disk path; skip http(s) and data.
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return null;
  const candidatePath = url;
  const fname = filename ?? basename(candidatePath) ?? 'upload';
  return { filename: fname, diskPath: candidatePath, isImage };
}

function buildInjectionText(files: SavedFile[]): string {
  const lines = files.map((f) => {
    const base = `[File uploaded: ${f.filename}. Saved to: ${f.diskPath}. When delegating to subagents, include this path in the delegation prompt so the subagent can read the file with its read tool.]`;
    if (f.isImage) {
      return `${base} Note: the image bytes were removed because your model may not support image input.`;
    }
    return base;
  });
  return lines.join('\n');
}

export function processFileAttachments(args: {
  messages: MessageWithParts[];
  workDir: string;
  log: (msg: string) => void;
}): void {
  const { messages, workDir, log } = args;

  // Save uploads inside the project's .opencode/uploads/ directory.
  // This is within the workspace so the read tool won't require extra
  // permissions, and the path survives the text-only task delegation hop.
  const saveDir = join(workDir, '.opencode', 'uploads');

  // Find user messages that carry at least one file part.
  const messagesWithFiles = messages.filter(
    (m) =>
      m.info.role === 'user' && m.parts.some((p) => isFilePart(p as FilePart)),
  );

  if (messagesWithFiles.length === 0) {
    if (existsSync(saveDir)) cleanupAllSessions(saveDir);
    return;
  }

  const gitignorePath = join(workDir, '.opencode', '.gitignore');
  try {
    mkdirSync(saveDir, { recursive: true });
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n');
  } catch (e) {
    log(`[upload-hook] failed to create uploads directory: ${e}`);
  }

  cleanupAllSessions(saveDir);

  for (const msg of messagesWithFiles) {
    const sessionSubdir = msg.info.sessionID
      ? sanitizeFilename(msg.info.sessionID)
      : undefined;
    const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      log(`[upload-hook] failed to create target uploads directory: ${e}`);
    }

    // Walk the parts in order: save each file part to disk, then either
    // strip (images) or keep (non-images) the original, and collect a
    // path-injection text line for each saved file.
    const newParts: typeof msg.parts = [];
    const savedFiles: SavedFile[] = [];

    for (const p of msg.parts) {
      const part = p as FilePart;
      if (!isFilePart(part)) {
        newParts.push(p);
        continue;
      }

      const saved = saveFilePart(part, targetDir, log);
      if (!saved) {
        // No usable disk path — leave the original part untouched.
        newParts.push(p);
        continue;
      }

      savedFiles.push(saved);
      if (saved.isImage) {
        // Strip image bytes; the path-injection text replaces them below.
      } else {
        // Keep the original file part so models that support it can use
        // it natively, while the injected path enables delegation.
        newParts.push(p);
      }
    }

    if (savedFiles.length > 0) {
      const pathsText = savedFiles.map((f) => f.diskPath).join(', ');
      log(`[upload-hook] saved uploads to disk: ${pathsText}`);
      newParts.push({ type: 'text', text: buildInjectionText(savedFiles) });
    }

    msg.parts = newParts;
  }
}
