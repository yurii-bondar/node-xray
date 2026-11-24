// Local paths from different sources (the CLI's `/api/lines`, source maps, VS Code's fsPath, the
// dashboard) → one comparable form, and which of them the dashboard may open.

/**
 * Forward slashes, `.` and `..` resolved, empty segments dropped; on Windows lower-cased, since the
 * drive letter differs by source (`C:` from V8, `c:` from VS Code) and NTFS ignores case.
 */
export function pathKey(path: string, platform: string): string {
  const [head = '', ...rest] = path.replace(/\\/g, '/').split('/');
  const segments: string[] = [];
  for (const segment of rest) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const key = `${head}/${segments.join('/')}`;
  return platform === 'win32' ? key.toLowerCase() : key;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

export interface OpenRule {
  /** Keys (`pathKey`) of the files the CLI reported CPU lines for: the program's own code. */
  readonly seen: ReadonlySet<string>;
  /** Workspace folders and the run's working directory, where source-mapped originals live. */
  readonly roots: readonly string[];
  readonly platform: string;
}

/** Whether a file the dashboard asks for is one of the profiled program's, not any file on disk. */
export function mayOpen(file: string, { seen, roots, platform }: OpenRule): boolean {
  if (!isAbsolutePath(file)) return false;
  const key = pathKey(file, platform);
  if (seen.has(key)) return true;
  return roots.some((root) => {
    const rootKey = pathKey(root, platform);
    return key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
  });
}
