// combobox.ts — the listbox contract a typeahead owes a screen reader.
//
// Framework-free on purpose, the same way `sidebar.ts` is: the arithmetic is
// pure, so it can be tested without a DOM, and `react.tsx` is left holding only
// the hook that calls it.
//
// `useTypeahead` already shared the state machine across five surfaces in three
// wikis. The ARIA did not travel with it, and all five had drifted into
// different wrongness:
//
//   - one put `aria-selected` on a plain `<button>`, which is not a role that
//     takes it, and gave the container no `role="listbox"` at all;
//   - one gave the rows `role="option"` but still no listbox, so the options
//     had no owner;
//   - two had no roles whatsoever;
//   - one used a `data-highlighted` attribute, which no assistive technology
//     reads.
//
// None of the five set `aria-activedescendant`, which is the attribute that
// actually announces the highlighted row as the reader arrows through it. A
// combobox without it is a text field that silently changes what Enter does.

/** Which surface a set of controls belongs to, when one hook feeds several. */
export interface ComboboxInput {
  /** Stable per-mount prefix. React callers pass `useId()`. */
  baseId: string;
  /** Distinguishes surfaces sharing one hook. A header with a desktop and a
   *  mobile list renders both into the same document; one id set for both
   *  would duplicate every option id and leave `aria-activedescendant`
   *  pointing at whichever copy the parser reached first. */
  listKey?: string;
  /** How many rows are currently rendered. */
  count: number;
  /** Index of the highlighted row. */
  highlight: number;
  /**
   * Whether the surface is actually showing its list. Defaults to `count > 0`.
   *
   * The hook knows how many results it holds; only the surface knows whether it
   * is rendering them. A header that hides its dropdown on blur while the hook
   * still holds items would otherwise claim `aria-expanded` for a list that is
   * not in the document, and point `aria-activedescendant` at a row that is not
   * there — which is the dangling reference this module exists to prevent.
   */
  open?: boolean;
}

export interface ComboboxInputProps {
  role: 'combobox';
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-autocomplete': 'list';
  'aria-activedescendant': string | undefined;
}

export interface ComboboxListProps {
  id: string;
  role: 'listbox';
}

export interface ComboboxOptionProps {
  id: string;
  role: 'option';
  'aria-selected': boolean;
}

export interface ComboboxAria {
  inputProps: ComboboxInputProps;
  listProps: ComboboxListProps;
  optionProps: (index: number) => ComboboxOptionProps;
}

/** The id of one option row. Exported because a caller that scrolls the
 *  highlighted row into view has to find it by the same id the input points at. */
export function optionId(baseId: string, listKey: string | undefined, index: number): string {
  return `${listId(baseId, listKey)}-opt-${index}`;
}

export function listId(baseId: string, listKey?: string): string {
  return listKey ? `${baseId}-${listKey}` : `${baseId}-list`;
}

/**
 * Every attribute the three parts of a combobox need, derived from what the
 * typeahead already knows.
 *
 * `aria-activedescendant` is omitted rather than emptied when nothing is
 * highlighted or the list is closed. An id that resolves to no element is worse
 * than no attribute: the reader announces nothing and the field still claims to
 * have an active option.
 */
export function comboboxAria({ baseId, listKey, count, highlight, open }: ComboboxInput): ComboboxAria {
  const list = listId(baseId, listKey);
  const expanded = (open ?? true) && count > 0;
  const active = expanded && highlight >= 0 && highlight < count;
  return {
    inputProps: {
      role: 'combobox',
      'aria-expanded': expanded,
      'aria-controls': list,
      'aria-autocomplete': 'list',
      'aria-activedescendant': active ? optionId(baseId, listKey, highlight) : undefined,
    },
    listProps: { id: list, role: 'listbox' },
    optionProps: (index: number) => ({
      id: optionId(baseId, listKey, index),
      role: 'option',
      'aria-selected': index === highlight,
    }),
  };
}
