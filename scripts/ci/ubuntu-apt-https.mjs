import fs, { constants } from 'node:fs/promises';
import { join } from 'node:path';

const officialHttp = /^http:\/\/(?:archive|us\.archive|security)\.ubuntu\.com(?:\/[^\s#]*)?$/;
const officialUbuntuHttps = /^https:\/\/(?:archive|us\.archive|security)\.ubuntu\.com\/ubuntu\/?$/;
const sonicUbuntuHttp = /^http:\/\/mirrors\.sonic\.net\/ubuntu\/?$/;

export function transformSources(text, format) {
  if (!['list', 'sources', 'mirrors'].includes(format)) {
    throw new Error(`Unsupported source format: ${format}`);
  }
  const upgrade = (uri) => officialHttp.test(uri) ? `https${uri.slice(4)}` : uri;
  let inUris = false;
  let lines = text.split('\n').map((line) => {
    if (format === 'sources') {
      if (/^[ \t]*#/.test(line)) return line;
      if (!/^[ \t]/.test(line) || /^\s*$/.test(line)) {
        inUris = /^URIs:/i.test(line);
      }
      if (!inUris) return line;
      // Only URIs and their continuation lines, never other fields or comments.
      return line.replace(/^(URIs:)?([^#]*)/i, (_, field, uris) =>
        (field ?? '') + uris.replace(/\S+/g, upgrade));
    }
    const prefix = format === 'list'
      ? /^([ \t]*deb(?:-src)?[ \t]+(?:\[[^\]\r\n]*\][ \t]+)?)([^\s#]+)/
      : /^([ \t]*)([^\s#]+)/;
    return line.replace(prefix, (_, before, uri) => before + upgrade(uri));
  });

  if (format === 'mirrors') {
    const uriOf = (line) => line.match(/^[ \t]*([^\s#]+)/)?.[1] ?? '';
    // Keep the mirror list and its metadata; omit only the observed failing entry.
    if (lines.some((line) => officialUbuntuHttps.test(uriOf(line)))) {
      lines = lines.map((line) => sonicUbuntuHttp.test(uriOf(line)) ? `# ${line}` : line);
    }
  }
  return lines.join('\n');
}

// The CLI fixes /etc/apt only. The directory argument is for owned temporary fixtures.
export async function rewriteAptSources(aptDirectory = '/etc/apt') {
  const root = await fs.lstat(aptDirectory);
  if (!root.isDirectory()) throw new Error(`Expected a real directory: ${aptDirectory}`);
  const files = [
    ['sources.list', 'list'],
    ['blacksmith-ubuntu-mirrors.txt', 'mirrors'],
  ];
  const sourcesDirectory = join(aptDirectory, 'sources.list.d');
  let directory;
  try {
    directory = await fs.lstat(sourcesDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (directory) {
    if (!directory.isDirectory()) throw new Error(`Expected a real directory: ${sourcesDirectory}`);
    for (const name of (await fs.readdir(sourcesDirectory)).sort()) {
      if (name.endsWith('.list') || name.endsWith('.sources')) {
        files.push([join('sources.list.d', name), name.endsWith('.sources') ? 'sources' : 'list']);
      }
    }
  }

  const changed = [];
  for (const [name, format] of files) {
    const path = join(aptDirectory, name);
    let handle;
    try {
      // Do not follow file symlinks or block on a FIFO. No file is ever created.
      handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected a single-link regular file: ${path}`);
      const original = await handle.readFile('utf8');
      const updated = transformSources(original, format);
      if (updated === original) continue;
      const bytes = Buffer.from(updated);
      // Write through the same descriptor, retaining the inode, owner, and mode.
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten === 0) throw new Error(`No progress writing ${path}`);
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
      changed.push(path);
    } finally {
      await handle.close();
    }
  }
  return changed;
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error('This helper takes no arguments and only edits /etc/apt.');
  for (const path of await rewriteAptSources()) console.log(`Updated ${path}`);
}
