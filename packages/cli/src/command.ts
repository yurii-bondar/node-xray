// How `run` starts the command. On Windows `npm`, `npx`, `yarn` are `.cmd` scripts, which Node
// (since the CVE-2024-27980 fix) refuses to spawn without a shell; xray runs those through
// `cmd.exe /d /s /c` with every argument escaped for it, and everything else as on other platforms.

import path from 'node:path';

export interface WindowsLookup {
  /** `PATH`. */
  readonly path: string;
  /** `PATHEXT`; empty = the default `.COM;.EXE;.BAT;.CMD`. */
  readonly pathext: string;
  readonly cwd: string;
  isFile(file: string): boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The file `cmd.exe` would run for `command`: the current directory first, then each `PATH` entry
 * (a command with a directory part only there), each name tried with the `PATHEXT` extensions
 * unless it already has one of them. Null when there is none.
 */
export function resolveWindowsCommand(command: string, lookup: WindowsLookup): string | null {
  const extensions = (lookup.pathext.trim() === '' ? DEFAULT_PATHEXT : lookup.pathext)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  const lower = command.toLowerCase();
  const names = extensions.some((ext) => lower.endsWith(ext)) ? [command] : extensions.map((ext) => command + ext);
  const hasDirectory = /[\\/]/.test(command) || path.win32.isAbsolute(command);
  const dirs = hasDirectory
    ? [lookup.cwd]
    : [lookup.cwd, ...lookup.path.split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter((dir) => dir !== '')];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.win32.resolve(lookup.cwd, dir, name);
      if (lookup.isFile(file)) return file;
    }
  }
  return null;
}

/** Characters `cmd.exe` gives a meaning to; a caret makes each one literal. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a batch file run by `cmd.exe`: quoted and backslash-escaped for the program's
 * own command-line parser (the C runtime rules), then every meta character caret-escaped twice:
 * once for the `cmd /c` line, once more because shims (`npm.cmd`, `node_modules\.bin\*.cmd`) pass
 * `%*` on and cmd parses it again. A `%` is never expanded: the caret splits the variable name.
 */
export function cmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** The text after `cmd.exe /d /s /c`, outer quotes included (`/s` strips exactly those). */
export function cmdLine(file: string, args: readonly string[]): string {
  return `"${[file.replace(CMD_META, '^$1'), ...args.map(cmdArgument)].join(' ')}"`;
}

export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  /** Pass `args` as they are (`windowsVerbatimArguments`): `cmdLine` already quoted them. */
  readonly verbatim: boolean;
}

export interface WindowsShell extends WindowsLookup {
  /** `ComSpec`, else `cmd.exe`. */
  readonly comspec: string;
}

/** On Windows, a command that resolves to a `.cmd` / `.bat` file goes through `cmd.exe`; anything else is spawned as given. */
export function windowsSpawnPlan(command: string, args: readonly string[], shell: WindowsShell): SpawnPlan {
  const file = resolveWindowsCommand(command, shell);
  if (file === null || !/\.(?:cmd|bat)$/i.test(file)) return { file: command, args, verbatim: false };
  return { file: shell.comspec, args: ['/d', '/s', '/c', cmdLine(file, args)], verbatim: true };
}
