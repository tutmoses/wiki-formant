'use client';

// block-editor.tsx — the block list an author edits, and the fields of the core
// block types.
//
// Three wikis had written this, 500 to 700 lines each, and the copies had
// drifted the way copies do: one dropped a stored code language that was not
// in its list, one let a typed count run past the row cap, one named every
// remove button "Remove", one never highlighted the block being edited. The
// behaviour lives here once. The look does not: each wiki draws its inputs,
// toggles and menus with its own design system, so those arrive as a KIT —
// class names, icons, and four optional components — and the markup here is
// bare semantic HTML wearing whatever the kit says.
//
// The dispatch stays with the wiki. `renderBody` is a `switch` over its own
// closed union, as S4 of the workspace's STRUCTURE.md requires, so a new block
// type is a compile error there; its cases hand the core types to the field
// editors below and draw its native types themselves.
//
// The kit and the schema reach every nested list through context, which is
// what lets a column or an infobox hold a list without being handed the whole
// configuration. Keep both stable — a module constant or a `useMemo` — or every
// card re-renders on every keystroke.

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { BlockActions, useBlockOperations } from './react.js';
import {
  CODE_LANGS,
  DEFAULT_LANG,
  type BannerBlock,
  type CodeTabsBlock,
  type ColumnsBlock,
  type InfoboxBlock,
  type LinkGridBlock,
  type ReferencesBlock,
  type StatsBlock,
} from './blocks.js';
import { BANNER_VARIANTS } from './text.js';
import { MAX_BLOCK_ROWS } from './validation.js';
import { cx } from './html.js';

// ---- the kit ----------------------------------------------------------------

export interface BlockEditorClassNames {
  /** A page's block list. */
  list?: string;
  /** A column's or an infobox's. */
  nestedList?: string;
  /** The line an empty list shows. */
  empty?: string;
  /** A block. It carries `data-selected` while it is the one being edited, and `data-nested` inside a container. */
  card?: string;
  cardHead?: string;
  cardLabel?: string;
  cardActions?: string;
  /** Every icon button: a card's actions, add-below, remove. */
  action?: string;
  /** The Add block button at the foot of a list. */
  addBlock?: string;
  /** The default `Add` button: Add tab, Add link. */
  add?: string;
  /** The default `Menu`'s wrapper and panel. */
  menuAnchor?: string;
  menu?: string;
  menuItem?: string;
  menuText?: string;
  menuHint?: string;
  /** A vertical group of fields. */
  stack?: string;
  /** A row of inputs ending in a remove button. */
  row?: string;
  /** A group inside a block: a link group, a column. */
  nest?: string;
  /** What holds the columns of a columns block. */
  columns?: string;
  /** The default `Field`'s label. */
  field?: string;
  input?: string;
  /** Added to a code tab's language select. */
  lang?: string;
  /** Added to a code tab's textarea. */
  code?: string;
  /** Added to a stat's figure input. */
  figure?: string;
  /** Added to a count input. */
  number?: string;
  /** Row numbers, hints and notes. */
  muted?: string;
}

export interface BlockEditorIcons {
  add: ReactNode;
  up: ReactNode;
  down: ReactNode;
  duplicate: ReactNode;
  remove: ReactNode;
}

export interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

/** One of a few values: a toggle group, a chip row or a select. */
export interface ChoiceProps {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

/**
 * The add-block menu around its trigger. `trigger` is the button the editor
 * drew; a popover takes it as its anchor, an inline panel renders it first.
 */
export interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  /** The icon in a block's head that adds under it, rather than the list's foot button. */
  below: boolean;
  children: ReactNode;
}

export interface AddProps {
  onPress: () => void;
  children: ReactNode;
}

export interface BlockEditorKit {
  classNames: BlockEditorClassNames;
  icons: BlockEditorIcons;
  Field?: ComponentType<FieldProps>;
  Choice?: ComponentType<ChoiceProps>;
  Menu?: ComponentType<MenuProps>;
  Add?: ComponentType<AddProps>;
}

// ---- the schema -------------------------------------------------------------

export type EditableBlock = { id: string; type: string };

export interface BlockMeta {
  label: string;
  icon?: ReactNode;
  /** The line under the label in the add menu. */
  hint?: string;
}

export interface BlockSchema<B extends EditableBlock> {
  /** Undefined for a type this build does not know: it is shown by its raw type and kept as it is. */
  meta: (type: B['type']) => BlockMeta | undefined;
  create: (type: B['type']) => B;
  /** A copy with fresh ids at every level. */
  duplicate: (block: B) => B;
  /**
   * A block's fields. The wiki's own `switch`, so it stays exhaustive over its
   * union. Null for a type with no fields here: the card says it is kept as is.
   */
  renderBody: (block: B, onUpdate: (next: B) => void) => ReactNode;
  /** What a page's add menus offer, in their order. */
  types: readonly B['type'][];
  /** What a column's and an infobox's offer: never a container. */
  nestedTypes: readonly B['type'][];
  /** Types a list holds at most one of, such as an infobox an article lifts into its rail. */
  single?: readonly B['type'][];
}

interface EditorContext {
  kit: BlockEditorKit;
  schema: BlockSchema<EditableBlock>;
}

const Context = createContext<EditorContext | null>(null);

function useEditorContext(): EditorContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('A block field editor must render inside <BlockEditor>.');
  return ctx;
}

// ---- the list ---------------------------------------------------------------

export interface BlockEditorProps<B extends EditableBlock> {
  blocks: B[];
  onChange: (blocks: B[]) => void;
  schema: BlockSchema<B>;
  kit: BlockEditorKit;
}

/**
 * A page's blocks, edited: each in a card with its add-below, move, duplicate
 * and delete controls, and an add menu at the foot. Columns and infoboxes hold
 * the same list, offering `nestedTypes`.
 */
export function BlockEditor<B extends EditableBlock>({ blocks, onChange, schema, kit }: BlockEditorProps<B>) {
  const value = useMemo(() => ({ kit, schema: schema as unknown as BlockSchema<EditableBlock> }), [kit, schema]);
  return (
    <Context.Provider value={value}>
      <BlockList blocks={blocks} onChange={onChange as (blocks: EditableBlock[]) => void} />
    </Context.Provider>
  );
}

function BlockList({ blocks, onChange, nested = false }: { blocks: EditableBlock[]; onChange: (blocks: EditableBlock[]) => void; nested?: boolean }) {
  const { kit, schema } = useEditorContext();
  const c = kit.classNames;
  const ops = useBlockOperations(blocks, onChange, schema);
  const base = nested ? schema.nestedTypes : schema.types;
  // A string, so the offer is recomputed — and every card re-rendered — only
  // when a single-use type comes or goes, not on every keystroke.
  const held = (schema.single ?? []).filter(t => blocks.some(b => b.type === t)).join(' ');
  const offered = useMemo(() => base.filter(t => !held.split(' ').includes(t)), [base, held]);
  const insertNew = useCallback((type: string) => ops.insert(schema.create(type)), [ops.insert, schema]);

  return (
    <div className={nested ? c.nestedList : c.list}>
      {blocks.length === 0 && <p className={c.empty}>{nested ? 'Empty.' : 'Nothing here yet. Add the first block.'}</p>}
      {blocks.map((block, i) => (
        <BlockCard
          key={block.id}
          block={block}
          index={i}
          total={blocks.length}
          selected={ops.selectedIndex === i}
          nested={nested}
          offered={offered}
          update={ops.update}
          move={ops.move}
          duplicate={ops.duplicate}
          remove={ops.remove}
          insert={ops.insert}
          select={ops.setSelectedIndex}
        />
      ))}
      <InsertMenu types={offered} onPick={insertNew} />
    </div>
  );
}

interface BlockCardProps {
  block: EditableBlock;
  index: number;
  total: number;
  selected: boolean;
  nested: boolean;
  offered: readonly string[];
  update: (i: number, block: EditableBlock) => void;
  move: (from: number, to: number) => void;
  duplicate: (i: number) => void;
  remove: (i: number) => void;
  insert: (block: EditableBlock, at?: number) => void;
  select: (i: number) => void;
}

// Memoised on the list's ref-stable callbacks, so a keystroke in one block does
// not re-render every other block's editor.
const BlockCard = memo(function BlockCard({ block, index, total, selected, nested, offered, update, move, duplicate, remove, insert, select }: BlockCardProps) {
  const { kit, schema } = useEditorContext();
  const c = kit.classNames;
  const onUpdate = useCallback((next: EditableBlock) => update(index, next), [update, index]);
  const onSelect = useCallback(() => select(index), [select, index]);
  const meta = schema.meta(block.type);
  const label = meta?.label ?? block.type;
  const body = meta ? schema.renderBody(block, onUpdate) : null;

  return (
    <section className={c.card} data-selected={selected || undefined} data-nested={nested || undefined} onFocusCapture={onSelect} onClick={onSelect}>
      <div className={c.cardHead}>
        <span className={c.cardLabel}>
          {meta?.icon}
          {label}
        </span>
        <span className={c.cardActions}>
          <InsertMenu below types={offered} onPick={type => insert(schema.create(type), index + 1)} />
          <BlockActions index={index} total={total} ops={{ move, duplicate, remove }} icons={kit.icons} className={c.cardActions} buttonClassName={c.action} blockLabel={label} />
        </span>
      </div>
      {/* A type this build cannot edit is carried through untouched. */}
      {body ?? <p className={c.muted}>Kept as it is – this editor has no fields for it.</p>}
    </section>
  );
});

function InsertMenu({ types, onPick, below = false }: { types: readonly string[]; onPick: (type: string) => void; below?: boolean }) {
  const { kit, schema } = useEditorContext();
  const c = kit.classNames;
  const [open, setOpen] = useState(false);
  const Menu = kit.Menu ?? InlineMenu;
  const toggle = () => setOpen(o => !o);
  const trigger = below ? (
    <button type="button" className={c.action} title="Add a block below" aria-label="Add a block below" aria-expanded={open} onClick={toggle}>
      {kit.icons.add}
    </button>
  ) : (
    <button type="button" className={c.addBlock} aria-expanded={open} onClick={toggle}>
      {kit.icons.add}
      Add block
    </button>
  );
  return (
    <Menu open={open} onOpenChange={setOpen} trigger={trigger} below={below}>
      {types.map(type => {
        const meta = schema.meta(type);
        return (
          <button
            key={type}
            type="button"
            className={c.menuItem}
            onClick={e => {
              // Inside a card, a pick is not also a click on the card.
              e.stopPropagation();
              onPick(type);
              setOpen(false);
            }}
          >
            {meta?.icon}
            <span className={c.menuText}>
              <span>{meta?.label ?? type}</span>
              {meta?.hint && <span className={c.menuHint}>{meta.hint}</span>}
            </span>
          </button>
        );
      })}
    </Menu>
  );
}

function InlineMenu({ open, trigger, children }: MenuProps) {
  const c = useEditorContext().kit.classNames;
  return (
    <span className={c.menuAnchor}>
      {trigger}
      {open && <span className={c.menu}>{children}</span>}
    </span>
  );
}

// ---- the kit's parts, resolved ----------------------------------------------

/** A labelled field in the kit's style, for a wiki's own block editors as well as these. */
export function Field(props: FieldProps) {
  const { Field: Custom, classNames: c } = useEditorContext().kit;
  if (Custom) return <Custom {...props} />;
  return (
    <label className={c.field}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small className={c.muted}>{props.hint}</small>}
    </label>
  );
}

/** One of a few values in the kit's style; a `<select>` when the kit has none. */
export function Choice(props: ChoiceProps) {
  const { Choice: Custom, classNames: c } = useEditorContext().kit;
  if (Custom) return <Custom {...props} />;
  return (
    <Field label={props.label}>
      <select className={c.input} value={props.value} onChange={e => props.onChange(e.target.value)}>
        {props.options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Add({ onPress, children }: AddProps) {
  const { Add: Custom, classNames: c, icons } = useEditorContext().kit;
  if (Custom) return <Custom onPress={onPress}>{children}</Custom>;
  return (
    <button type="button" className={c.add} onClick={onPress}>
      {icons.add}
      {children}
    </button>
  );
}

function Remove({ label, onPress }: { label: string; onPress: () => void }) {
  const { classNames: c, icons } = useEditorContext().kit;
  return (
    <button type="button" className={c.action} title={label} aria-label={label} onClick={onPress}>
      {icons.remove}
    </button>
  );
}

/** A text input. `optional` stores an emptied field as absent rather than `''`. */
function TextInput({
  label,
  value,
  onChange,
  placeholder = label,
  optional = false,
  type = 'text',
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  optional?: boolean;
  type?: 'text' | 'url';
  className?: string;
}) {
  const c = useEditorContext().kit.classNames;
  return (
    <input
      type={type}
      className={cx(c.input, className)}
      aria-label={label}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={e => onChange(optional ? e.target.value.trim() ? e.target.value : undefined : e.target.value)}
    />
  );
}

const replaceAt = <T,>(items: readonly T[], i: number, item: T): T[] => items.map((x, j) => (j === i ? item : x));
const removeAt = <T,>(items: readonly T[], i: number): T[] => items.filter((_, j) => j !== i);
const newId = () => crypto.randomUUID();

// ---- the core blocks' fields -------------------------------------------------

/** A count clamped to 1…`MAX_BLOCK_ROWS`, the cap the write path enforces. */
export function LimitField({ label = 'How many', value, onChange }: { label?: string; value: number | undefined; onChange: (n: number) => void }) {
  const c = useEditorContext().kit.classNames;
  return (
    <Field label={label}>
      <input
        type="number"
        min={1}
        max={MAX_BLOCK_ROWS}
        className={cx(c.input, c.number)}
        value={value ?? ''}
        onChange={e => onChange(Math.min(MAX_BLOCK_ROWS, Math.max(1, Math.floor(Number(e.target.value)) || 1)))}
      />
    </Field>
  );
}

/**
 * `code` is source text, never HTML: every view escapes it. A stored language
 * outside `langs` stays selectable rather than reading as the first option and
 * being overwritten on the next save.
 */
export function CodeTabsFields({
  block,
  onUpdate,
  langs = CODE_LANGS,
  defaultLang = DEFAULT_LANG,
}: {
  block: CodeTabsBlock;
  onUpdate: (block: CodeTabsBlock) => void;
  langs?: readonly string[];
  defaultLang?: string;
}) {
  const c = useEditorContext().kit.classNames;
  const tabs = block.tabs;
  const set = (next: CodeTabsBlock['tabs']) => onUpdate({ ...block, tabs: next });
  return (
    <div className={c.stack}>
      {tabs.map((tab, i) => (
        <div key={i} className={c.stack}>
          <div className={c.row}>
            <TextInput label="Tab label" value={tab.label} onChange={label => set(replaceAt(tabs, i, { ...tab, label: label ?? '' }))} />
            <select aria-label="Language" className={cx(c.input, c.lang)} value={tab.language} onChange={e => set(replaceAt(tabs, i, { ...tab, language: e.target.value }))}>
              {[...new Set([tab.language, ...langs])].map(l => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <Remove label={`Remove tab ${tab.label || i + 1}`} onPress={() => set(removeAt(tabs, i))} />
          </div>
          <textarea
            aria-label="Code"
            placeholder="Code"
            rows={6}
            spellCheck={false}
            className={cx(c.input, c.code)}
            value={tab.code}
            onChange={e => set(replaceAt(tabs, i, { ...tab, code: e.target.value }))}
          />
        </div>
      ))}
      <Add onPress={() => set([...tabs, { label: '', language: defaultLang, code: '' }])}>Add tab</Add>
    </div>
  );
}

export function StatsFields({ block, onUpdate, hint }: { block: StatsBlock; onUpdate: (block: StatsBlock) => void; hint?: string }) {
  const c = useEditorContext().kit.classNames;
  const items = block.items;
  const set = (next: StatsBlock['items']) => onUpdate({ ...block, items: next });
  return (
    <div className={c.stack}>
      <Choice
        label="Per row"
        value={String(block.columns)}
        options={['2', '3', '4'].map(n => ({ value: n, label: n }))}
        onChange={n => onUpdate({ ...block, columns: Number(n) as StatsBlock['columns'] })}
      />
      {items.map((item, i) => (
        <div key={item.id} className={c.row}>
          <TextInput label="Figure" className={c.figure} value={item.value} onChange={value => set(replaceAt(items, i, { ...item, value: value ?? '' }))} />
          <TextInput label="What it counts" value={item.label} onChange={label => set(replaceAt(items, i, { ...item, label: label ?? '' }))} />
          <Remove label={`Remove figure ${i + 1}`} onPress={() => set(removeAt(items, i))} />
        </div>
      ))}
      <Add onPress={() => set([...items, { id: newId(), value: '', label: '' }])}>Add figure</Add>
      {hint && <small className={c.muted}>{hint}</small>}
    </div>
  );
}

/** `title` is the heading a references block shows when it stores none, and `noun` what one row is called. */
export function ReferencesFields({
  block,
  onUpdate,
  title = 'References',
  noun = 'reference',
  hint,
}: {
  block: ReferencesBlock;
  onUpdate: (block: ReferencesBlock) => void;
  title?: string;
  noun?: string;
  hint?: string;
}) {
  const c = useEditorContext().kit.classNames;
  const items = block.items;
  const set = (next: ReferencesBlock['items']) => onUpdate({ ...block, items: next });
  return (
    <div className={c.stack}>
      <Field label="Heading">
        <TextInput label="Heading" placeholder={title} optional value={block.title} onChange={t => onUpdate({ ...block, title: t })} />
      </Field>
      {items.map((item, i) => (
        <div key={item.id} className={c.row}>
          <span className={c.muted}>{i + 1}.</span>
          <TextInput label="Title, author, publisher" value={item.text} onChange={text => set(replaceAt(items, i, { ...item, text: text ?? '' }))} />
          <TextInput label="Address" type="url" placeholder="https://" optional value={item.url} onChange={url => set(replaceAt(items, i, { ...item, url }))} />
          <Remove label={`Remove ${noun} ${i + 1}`} onPress={() => set(removeAt(items, i))} />
        </div>
      ))}
      <Add onPress={() => set([...items, { id: newId(), text: '' }])}>Add {noun}</Add>
      {hint && <small className={c.muted}>{hint}</small>}
    </div>
  );
}

export function LinkGridFields({ block, onUpdate }: { block: LinkGridBlock; onUpdate: (block: LinkGridBlock) => void }) {
  const c = useEditorContext().kit.classNames;
  const groups = block.groups;
  return (
    <div className={c.stack}>
      <Field label="Intro (optional)">
        <TextInput label="Intro" placeholder="A paragraph before the groups" optional value={block.intro} onChange={intro => onUpdate({ ...block, intro })} />
      </Field>
      {groups.map((group, gi) => {
        const setGroup = (next: typeof group) => onUpdate({ ...block, groups: replaceAt(groups, gi, next) });
        return (
          <div key={group.id} className={cx(c.nest, c.stack)}>
            <div className={c.row}>
              <TextInput label="Heading" value={group.heading} onChange={heading => setGroup({ ...group, heading: heading ?? '' })} />
              <Remove label={`Remove group ${group.heading || gi + 1}`} onPress={() => onUpdate({ ...block, groups: removeAt(groups, gi) })} />
            </div>
            <TextInput
              label="Description"
              placeholder="Description (optional)"
              optional
              value={group.description ?? undefined}
              onChange={description => setGroup({ ...group, description })}
            />
            {group.links.map((link, li) => (
              <div key={li} className={c.row}>
                <TextInput label="Label" value={link.label} onChange={label => setGroup({ ...group, links: replaceAt(group.links, li, { ...link, label: label ?? '' }) })} />
                <TextInput
                  label="Address"
                  placeholder="/path or https://"
                  value={link.href}
                  onChange={href => setGroup({ ...group, links: replaceAt(group.links, li, { ...link, href: href ?? '' }) })}
                />
                <Remove label={`Remove link ${link.label || li + 1}`} onPress={() => setGroup({ ...group, links: removeAt(group.links, li) })} />
              </div>
            ))}
            <Add onPress={() => setGroup({ ...group, links: [...group.links, { label: '', href: '' }] })}>Add link</Add>
          </div>
        );
      })}
      <Add onPress={() => onUpdate({ ...block, groups: [...groups, { id: newId(), heading: '', links: [] }] })}>Add group</Add>
    </div>
  );
}

export function BannerFields({ block, onUpdate }: { block: BannerBlock; onUpdate: (block: BannerBlock) => void }) {
  const c = useEditorContext().kit.classNames;
  return (
    <div className={c.stack}>
      <Choice label="Notice" value={block.variant} options={BANNER_VARIANTS} onChange={v => onUpdate({ ...block, variant: v as BannerBlock['variant'] })} />
      <Field label="Custom message (optional)">
        <TextInput label="Custom message" placeholder="Empty for the standard notice" optional value={block.text} onChange={text => onUpdate({ ...block, text })} />
      </Field>
    </div>
  );
}

/** A page a page list can pick. `detail` is shown after the title, such as its section. */
export interface PageOption {
  id: string;
  title: string;
  detail?: string;
}

/**
 * The picked pages in their order, each movable and removable. With `pages`
 * the rest are offered in a picker; without, an id is typed in.
 */
export function PageListFields<B extends { pageIds: string[] }>({ block, onUpdate, pages }: { block: B; onUpdate: (block: B) => void; pages?: readonly PageOption[] }) {
  const { kit } = useEditorContext();
  const c = kit.classNames;
  const [typed, setTyped] = useState('');
  const ids = block.pageIds;
  const set = (pageIds: string[]) => onUpdate({ ...block, pageIds });
  const byId = new Map(pages?.map(p => [p.id, p]));
  const full = ids.length >= MAX_BLOCK_ROWS;
  const add = (id: string) => {
    if (id && !ids.includes(id) && !full) set([...ids, id]);
  };
  const unpicked = pages?.filter(p => !ids.includes(p.id)) ?? [];
  const ops = {
    move: (from: number, to: number) => {
      const next = removeAt(ids, from);
      next.splice(to, 0, ids[from]!);
      set(next);
    },
    duplicate: () => {},
    remove: (i: number) => set(removeAt(ids, i)),
  };

  return (
    <div className={c.stack}>
      {ids.map((id, i) => {
        const page = byId.get(id);
        return (
          <div key={i} className={c.row}>
            <span className={c.muted}>{i + 1}.</span>
            <span>
              {pages ? (page?.title ?? `No such page: ${id}`) : id}
              {page?.detail && <span className={c.muted}> · {page.detail}</span>}
            </span>
            <BlockActions
              index={i}
              total={ids.length}
              ops={ops}
              icons={{ up: kit.icons.up, down: kit.icons.down, remove: kit.icons.remove }}
              className={c.cardActions}
              buttonClassName={c.action}
              blockLabel="page"
            />
          </div>
        );
      })}
      {pages && pages.length === 0 && <p className={c.muted}>This wiki has no pages to pick yet.</p>}
      {!full && pages && unpicked.length > 0 && (
        <Field label="Add a page">
          <select className={c.input} value="" onChange={e => add(e.target.value)}>
            <option value="">Choose…</option>
            {unpicked.map(p => (
              <option key={p.id} value={p.id}>
                {p.detail ? `${p.title} · ${p.detail}` : p.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!full && !pages && (
        <div className={c.row}>
          <input
            type="text"
            className={c.input}
            aria-label="Page id"
            placeholder="Page id"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              add(typed.trim());
              setTyped('');
            }}
          />
          <Add
            onPress={() => {
              add(typed.trim());
              setTyped('');
            }}
          >
            Add page
          </Add>
        </div>
      )}
    </div>
  );
}

const GAPS = ['sm', 'md', 'lg'].map(v => ({ value: v, label: v }));
const ALIGNS = ['start', 'center', 'end', 'stretch'].map(v => ({ value: v, label: v }));
const MAX_COLUMNS = 4;

/** Two to four columns, each a block list offering the schema's `nestedTypes`. */
export function ColumnsFields<A extends EditableBlock>({ block, onUpdate }: { block: ColumnsBlock<A>; onUpdate: (block: ColumnsBlock<A>) => void }) {
  const c = useEditorContext().kit.classNames;
  const columns = block.columns;
  return (
    <div className={c.stack}>
      <div className={c.row}>
        <Choice label="Gap" value={block.gap ?? 'md'} options={GAPS} onChange={gap => onUpdate({ ...block, gap: gap as ColumnsBlock<A>['gap'] })} />
        <Choice label="Align" value={block.align ?? 'start'} options={ALIGNS} onChange={align => onUpdate({ ...block, align: align as ColumnsBlock<A>['align'] })} />
      </div>
      <div className={c.columns}>
        {columns.map((column, ci) => (
          <div key={column.id} className={cx(c.nest, c.stack)}>
            <div className={c.cardHead}>
              <span className={c.cardLabel}>Column {ci + 1}</span>
              {columns.length > 1 && <Remove label={`Remove column ${ci + 1}`} onPress={() => onUpdate({ ...block, columns: removeAt(columns, ci) })} />}
            </div>
            <BlockList
              nested
              blocks={column.blocks}
              onChange={blocks => onUpdate({ ...block, columns: replaceAt(columns, ci, { ...column, blocks: blocks as A[] }) })}
            />
          </div>
        ))}
      </div>
      {columns.length < MAX_COLUMNS && <Add onPress={() => onUpdate({ ...block, columns: [...columns, { id: newId(), blocks: [] }] })}>Add column</Add>}
    </div>
  );
}

/** An infobox's blocks, offering the schema's `nestedTypes`. */
export function InfoboxFields<A extends EditableBlock>({ block, onUpdate }: { block: InfoboxBlock<A>; onUpdate: (block: InfoboxBlock<A>) => void }) {
  return <BlockList nested blocks={block.blocks} onChange={blocks => onUpdate({ ...block, blocks: blocks as A[] })} />;
}
