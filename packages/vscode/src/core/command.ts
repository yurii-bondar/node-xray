// A command line as typed into an input box → program and arguments, without a shell: the
// terminal runs xray directly, so quoting has to be understood here.

export interface CommandLine {
  readonly program: string;
  readonly args: readonly string[];
}

/** POSIX-like splitting: whitespace separates, '…' is literal, "…" allows \" and \\. Null on unbalanced quotes. */
export function splitCommand(text: string): CommandLine | null {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i] as string;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else if (char === '\\' && i + 1 < text.length) {
      current += text[++i] as string;
      inWord = true;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) words.push(current);
  const [program, ...args] = words;
  return program === undefined ? null : { program, args };
}
