import type { ProgressPart } from '@serverdeck/plugin-sdk/types/platform';

/** A single bounded in-flight read; stopping also wakes the idle timer. */
export function followProgress(
  read: (revision: number, offset: number) => Promise<ProgressPart>,
  visible: () => boolean,
  update: (text: string) => void,
  failed: (error: unknown) => void,
): () => Promise<void> {
  let active = true,
    revision = 0,
    offset = 0,
    text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  void (async () => {
    while (active) {
      if (visible()) {
        const part = await read(revision, offset);
        if (!active) break;
        if (part.revision !== revision) text = '';
        revision = part.revision;
        offset = part.offset;
        text += part.text;
        update(text);
      }
      if (active)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 250);
        });
    }
  })().catch((error: unknown) => {
    if (active) failed(error);
  });
  return async () => {
    active = false;
    if (timer) clearTimeout(timer);
    wake?.();
  };
}
