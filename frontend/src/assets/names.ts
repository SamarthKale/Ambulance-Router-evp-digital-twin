/**
 * Node-name matching for driven parts (lamps, siren, wheels). No imports, so the Node-run
 * check:assets script can use it as is.
 */

/** Case, punctuation and Blender's ".001" suffix don't matter (the loader also strips "."). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The manifest part a node name stands for, or null. */
export function matchPart(
  nodeName: string,
  parts: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>> = {},
): string | null {
  const name = normalizeName(nodeName);
  const candidates = [name, name.replace(/\d{3}$/, "")];
  for (const part of parts) {
    const names = [part, ...(aliases[part] ?? [])].map(normalizeName);
    if (names.some((n) => candidates.includes(n))) return part;
  }
  return null;
}
