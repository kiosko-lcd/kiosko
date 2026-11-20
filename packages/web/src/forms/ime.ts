/**
 * Text fields that people type into with an input method (pinyin, zhuyin,
 * kana): the text is only theirs once the composition ends, so it is not
 * saved (or acted on) halfway. Spread on an <input> or <textarea>:
 *   <input value={v} {...typed((text) => save(text))} />
 */
type Field = HTMLInputElement | HTMLTextAreaElement;

export function typed(onValue: (text: string) => void): { onInput: (e: Event) => void; onCompositionEnd: (e: Event) => void } {
  return {
    onInput: (e) => {
      if (!(e as InputEvent).isComposing) onValue((e.target as Field).value);
    },
    onCompositionEnd: (e) => onValue((e.target as Field).value),
  };
}
