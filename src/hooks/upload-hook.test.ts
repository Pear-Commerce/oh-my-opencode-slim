import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageWithParts } from './types';
import { processFileAttachments } from './upload-hook';

function findInDir(dir: string, prefix: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(prefix));
}

// Tiny (1x1) PNG as a data URL.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// "hello" as a PDF data URL (minimal valid-ish PDF bytes).
const PDF_DATA_URL =
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhbXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCjIgMCBvYmoKPDwvVHlwZS9QYWVzL0NvdW50IDEvS2lkc1szIDAgUl0+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXT4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDBuIAo8PC9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjkKJSVFT0YK';

function userMessage(parts: unknown[]): MessageWithParts {
  return {
    info: { role: 'user', sessionID: 'test-session-1' },
    parts: parts as MessageWithParts['parts'],
  };
}

const logs: string[] = [];
function log(msg: string): void {
  logs.push(msg);
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'omo-test-'));
  logs.length = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('processFileAttachments', () => {
  test('strips image data-URL parts and injects a disk-path text part', () => {
    const messages = [
      userMessage([
        { type: 'text', text: 'look at this' },
        {
          type: 'file',
          url: PNG_DATA_URL,
          mime: 'image/png',
          filename: 'pic.png',
        },
      ]),
    ];

    processFileAttachments({ messages, workDir, log });

    const parts = messages[0].parts;
    // Original text part preserved, image part stripped, one text part added.
    expect(
      parts.some((p) => p.type === 'text' && p.text === 'look at this'),
    ).toBe(true);
    expect(parts.filter((p) => p.type === 'file')).toHaveLength(0);

    const injected = parts.filter(
      (p) =>
        p.type === 'text' &&
        typeof p.text === 'string' &&
        p.text.includes('Saved to:'),
    );
    expect(injected).toHaveLength(1);
    const text = (injected[0] as { text: string }).text;
    expect(text).toContain('.opencode/uploads/');
    expect(text).toContain('pic.png');
    expect(text).toMatch(/image bytes were removed/);
    expect(text).toMatch(/subagent/);

    // File actually written to disk under the session subdir.
    const sessionDir = join(workDir, '.opencode', 'uploads', 'test-session-1');
    expect(existsSync(sessionDir)).toBe(true);
    expect(findInDir(sessionDir, 'pic-').length).toBeGreaterThan(0);
  });

  test('keeps non-image data-URL parts and still appends a disk-path text part', () => {
    const messages = [
      userMessage([
        { type: 'text', text: 'review this pdf' },
        {
          type: 'file',
          url: PDF_DATA_URL,
          mime: 'application/pdf',
          filename: 'doc.pdf',
        },
      ]),
    ];

    processFileAttachments({ messages, workDir, log });

    const parts = messages[0].parts;
    // Original text + the PDF file part are BOTH preserved.
    expect(
      parts.some((p) => p.type === 'text' && p.text === 'review this pdf'),
    ).toBe(true);
    const fileParts = parts.filter((p) => p.type === 'file');
    expect(fileParts).toHaveLength(1);
    expect((fileParts[0] as { mime?: string }).mime).toBe('application/pdf');

    // Plus an injected path text part.
    const injected = parts.filter(
      (p) =>
        p.type === 'text' &&
        typeof p.text === 'string' &&
        p.text.includes('Saved to:'),
    );
    expect(injected).toHaveLength(1);
    const text = (injected[0] as { text: string }).text;
    expect(text).toContain('.opencode/uploads/');
    expect(text).toContain('doc.pdf');
    // Non-image -> no "bytes were removed" note.
    expect(text).not.toMatch(/image bytes were removed/);

    // PDF written to disk.
    const sessionDir = join(workDir, '.opencode', 'uploads', 'test-session-1');
    expect(existsSync(sessionDir)).toBe(true);
    expect(findInDir(sessionDir, 'doc-').length).toBeGreaterThan(0);
  });

  test('runs without any agent/disabled-agent config (no observer gate)', () => {
    // The hook signature only takes messages/workDir/log — verify it processes
    // messages and writes to disk with no agent configuration whatsoever.
    const messages = [
      userMessage([
        {
          type: 'file',
          url: PNG_DATA_URL,
          mime: 'image/png',
          filename: 'solo.png',
        },
      ]),
    ];

    processFileAttachments({ messages, workDir, log });

    const parts = messages[0].parts;
    expect(parts.filter((p) => p.type === 'file')).toHaveLength(0);
    expect(
      parts.some(
        (p) =>
          p.type === 'text' &&
          typeof p.text === 'string' &&
          p.text.includes('Saved to:'),
      ),
    ).toBe(true);
    // No observer-related text should appear.
    expect(
      parts.some(
        (p) =>
          p.type === 'text' &&
          typeof p.text === 'string' &&
          /observer/i.test(p.text),
      ),
    ).toBe(false);
  });
});
