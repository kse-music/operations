// JSON scalars and quoted keys are valid YAML. Emit only the data model returned
// by the plugin; preserve strings such as "no", numeric ports and multiline commands.
export function composeYaml(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const scalar = (item: unknown) =>
    (JSON.stringify(item) ?? 'null').replace(
      /[\u0085\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((item) =>
        item !== null && typeof item === 'object' && Object.keys(item).length
          ? `${indent}-\n${composeYaml(item, depth + 1)}`
          : `${indent}- ${scalar(item)}`,
      )
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return entries
      .map(([name, item]) => {
        const key =
          /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name) && !/^(true|false|null|yes|no|on|off)$/i.test(name)
            ? name
            : scalar(name);
        return item !== null && typeof item === 'object' && Object.keys(item).length
          ? `${indent}${key}:\n${composeYaml(item, depth + 1)}`
          : `${indent}${key}: ${scalar(item)}`;
      })
      .join('\n');
  }
  return `${indent}${scalar(value)}`;
}
