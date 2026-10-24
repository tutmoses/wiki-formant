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
  EVENT_DATE,
  eventBegun,
  eventEnded,
  eventWhen,
  LIST_SOURCES,
  today,
  type ListSource,
  type BannerBlock,
  type CodeTabsBlock,
  type ColumnsBlock,
  type EventsBlock,
  type LocationsBlock,
  type InfoboxBlock,
  type LinkGridBlock,
  type ReferencesBlock,
  type StatsBlock,
  type TestimonialBlock,
} from './blocks.js';
import { BANNER_VARIANTS } from './text.js';
import { DAY_NAMES, DAYS, DEFAULT_ZONE, hoursRows, TIME, type Hours } from './hours.js';
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

const NO_LIST: BlockSchema<EditableBlock> = {
  meta: () => undefined,
  create: () => {
    throw new Error('ColumnsFields and InfoboxFields hold a block list: render them inside <BlockEditor>.');
  },
  duplicate: block => block,
  renderBody: () => null,
  types: [],
  nestedTypes: [],
};

/**
 * The core blocks' fields outside a `<BlockEditor>`, in `kit`'s style: for an
 * editor that draws each block in place and has a list of its own, as miow's
 * does. The two container fields hold a block list and still need the editor.
 */
export function BlockFieldsKit({ kit, children }: { kit: BlockEditorKit; children: ReactNode }) {
  const value = useMemo(() => ({ kit, schema: NO_LIST }), [kit]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
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

/** Someone's words exactly, and who they are: their name, and optionally their role and photo. */
export function TestimonialFields({ block, onUpdate }: { block: TestimonialBlock; onUpdate: (block: TestimonialBlock) => void }) {
  const c = useEditorContext().kit.classNames;
  return (
    <div className={c.stack}>
      <Field label="Their words">
        <textarea aria-label="Their words" placeholder="Their words, exactly as they said them" rows={3} className={c.input} value={block.quote} onChange={e => onUpdate({ ...block, quote: e.target.value })} />
      </Field>
      <div className={c.row}>
        <TextInput label="Who said them" value={block.author} onChange={author => onUpdate({ ...block, author: author ?? '' })} />
        <TextInput label="Their role (optional)" optional value={block.role} onChange={role => onUpdate({ ...block, role })} />
      </div>
      <TextInput label="Photo address (optional)" type="url" placeholder="https://" optional value={block.avatarUrl} onChange={avatarUrl => onUpdate({ ...block, avatarUrl })} />
    </div>
  );
}

/**
 * Events in the order they were written, each with how its dates read and
 * where the page sets it today: the page sorts them itself, and moves each on
 * once it ends. `text` is inline HTML, as a reference's is.
 */
export function EventsFields({ block, onUpdate, hint }: { block: EventsBlock; onUpdate: (block: EventsBlock) => void; hint?: string }) {
  const c = useEditorContext().kit.classNames;
  const items = block.items;
  const set = (next: EventsBlock['items']) => onUpdate({ ...block, items: next });
  const day = today();
  return (
    <div className={c.stack}>
      <div className={c.row}>
        <TextInput label="Heading over those to come" placeholder="Upcoming" optional value={block.upcoming} onChange={upcoming => onUpdate({ ...block, upcoming })} />
        <TextInput label="Heading over those that have ended" placeholder="Past" optional value={block.past} onChange={past => onUpdate({ ...block, past })} />
      </div>
      {items.map((e, i) => {
        const dated = EVENT_DATE.test(e.date) && (!e.end || EVENT_DATE.test(e.end));
        return (
          <div key={e.id} className={c.stack}>
            <div className={c.row}>
              <TextInput label="Starts" placeholder="Starts, e.g. 2026-11" value={e.date} onChange={date => set(replaceAt(items, i, { ...e, date: date ?? '' }))} />
              <TextInput label="Ends (optional)" optional value={e.end} onChange={end => set(replaceAt(items, i, { ...e, end }))} />
              <Remove label={`Remove event ${i + 1}`} onPress={() => set(removeAt(items, i))} />
            </div>
            <TextInput label="What it is and where" placeholder="What it is and where, e.g. Group show, Park Royal Gallery, London" value={e.text} onChange={text => set(replaceAt(items, i, { ...e, text: text ?? '' }))} />
            <small className={c.muted}>
              {dated ? `${eventWhen(e)} · ${eventEnded(e, day) ? 'past' : eventBegun(e, day) ? 'now on' : 'upcoming'}` : 'A year, month or day: 2026, 2026-11 or 2026-11-12'}
            </small>
          </div>
        );
      })}
      <Add onPress={() => set([...items, { id: newId(), date: day.slice(0, 7), text: '' }])}>Add event</Add>
      <small className={c.muted}>{hint ?? 'Readers see those to come soonest first and those that have ended latest first, each moving on its own once it ends.'}</small>
    </div>
  );
}

/** A place's hours, a row for each set of days that keeps the same times, with how the week will read under them. */
function HoursFields({ hours, onChange }: { hours: Hours[]; onChange: (hours: Hours[]) => void }) {
  const c = useEditorContext().kit.classNames;
  const valid = hours.filter(h => h.days.length && TIME.test(h.opens) && TIME.test(h.closes));
  return (
    <div className={c.stack}>
      {hours.map((h, i) => (
        <div key={i} className={c.row}>
          <span role="group" aria-label="Days">
            {DAYS.map((d, j) => (
              <label key={d} title={DAY_NAMES[j]}>
                <input
                  type="checkbox"
                  aria-label={DAY_NAMES[j]}
                  checked={h.days.includes(d)}
                  onChange={() => onChange(replaceAt(hours, i, { ...h, days: DAYS.filter(x => (x === d ? !h.days.includes(d) : h.days.includes(x))) }))}
                />
                {DAY_NAMES[j]!.slice(0, 3)}
              </label>
            ))}
          </span>
          <input type="time" aria-label="Opens" className={c.input} value={h.opens} onChange={e => onChange(replaceAt(hours, i, { ...h, opens: e.target.value }))} />
          <input type="time" aria-label="Closes" className={c.input} value={h.closes} onChange={e => onChange(replaceAt(hours, i, { ...h, closes: e.target.value }))} />
          <Remove label={`Remove hours ${i + 1}`} onPress={() => onChange(removeAt(hours, i))} />
        </div>
      ))}
      <Add onPress={() => onChange([...hours, { days: hours.length ? [] : ['mon', 'tue', 'wed', 'thu', 'fri'], opens: '09:00', closes: '17:00' }])}>Add opening hours</Add>
      {valid.length > 0 && <small className={c.muted}>{hoursRows(valid).map(r => `${r.label} ${r.times}`).join(' · ')}</small>}
    </div>
  );
}

/**
 * Places, each with its address or its hours: its name where there are
 * several, a picture, the address a line to a line, a map link, its hours day
 * by day, its clock, a note and how to reach it. The page says whether each is
 * open by its own clock.
 */
export function LocationsFields({ block, onUpdate }: { block: LocationsBlock; onUpdate: (block: LocationsBlock) => void }) {
  const c = useEditorContext().kit.classNames;
  const items = block.items;
  const set = (next: LocationsBlock['items']) => onUpdate({ ...block, items: next });
  return (
    <div className={c.stack}>
      <TextInput label="Heading over the places (optional)" placeholder="Our shops" optional value={block.heading} onChange={heading => onUpdate({ ...block, heading })} />
      {items.map((p, i) => {
        const setPlace = (patch: Partial<typeof p>) => set(replaceAt(items, i, { ...p, ...patch }));
        return (
          <div key={p.id} className={cx(c.nest, c.stack)}>
            <div className={c.row}>
              <TextInput label="Which one (optional)" placeholder="Covent Garden" optional value={p.name} onChange={name => setPlace({ name })} />
              <Remove label={`Remove place ${p.name || i + 1}`} onPress={() => set(removeAt(items, i))} />
            </div>
            <Field label="Address, a line to a line">
              <textarea
                aria-label="Address"
                rows={3}
                className={c.input}
                placeholder={'27 Monmouth Street\nLondon WC2H 9EU'}
                value={p.address ?? ''}
                onChange={e => setPlace({ address: e.target.value.trim() ? e.target.value : undefined })}
              />
            </Field>
            <TextInput label="Map link (optional)" type="url" placeholder="Unset, a search for the address" optional value={p.map} onChange={map => setPlace({ map })} />
            <HoursFields hours={p.hours ?? []} onChange={hours => setPlace({ hours: hours.length ? hours : undefined })} />
            {!!p.hours?.length && <TextInput label="Time zone" placeholder={DEFAULT_ZONE} optional value={p.timeZone} onChange={timeZone => setPlace({ timeZone })} />}
            <TextInput label="What the hours do not say (optional)" placeholder="Closed on bank holidays" optional value={p.note} onChange={note => setPlace({ note })} />
            <div className={c.row}>
              <TextInput label="Phone (optional)" placeholder="020 7232 3010" optional value={p.phone} onChange={phone => setPlace({ phone })} />
              <TextInput label="Email (optional)" placeholder="hello@example.com" optional value={p.email} onChange={email => setPlace({ email })} />
            </div>
            <TextInput label="Picture address (optional)" type="url" placeholder="https://" optional value={p.image} onChange={image => setPlace({ image })} />
          </div>
        );
      })}
      <Add onPress={() => set([...items, { id: newId(), hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], opens: '09:00', closes: '17:00' }] }])}>Add place</Add>
      <label>
        <input type="checkbox" checked={!!block.map} onChange={e => onUpdate({ ...block, map: e.target.checked || undefined })} /> Show a map of each address
      </label>
      <small className={c.muted}>Readers see the days grouped, today's marked, and whether each place is open now by its own clock.</small>
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
  return <PagePicker ids={block.pageIds} onChange={pageIds => onUpdate({ ...block, pageIds })} pages={pages} />;
}

/** Pages picked by key, in order: the body of a page list and of a list that picks its pages by hand. */
function PagePicker({ ids, onChange: set, pages }: { ids: string[]; onChange: (ids: string[]) => void; pages?: readonly PageOption[] }) {
  const { kit } = useEditorContext();
  const c = kit.classNames;
  const [typed, setTyped] = useState('');
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

/** What each of a list's sources is called where it is chosen. */
const LIST_SOURCE_LABELS: Record<ListSource, string> = {
  under: 'The pages in a section',
  newest: 'The newest pages',
  chosen: 'Pages picked by hand',
};

const LIST_SHOWS = [
  { value: 'links', label: 'As links, with their age' },
  { value: 'cards', label: 'As cards, with a picture and a line each' },
];

/**
 * A list block's fields: where its pages come from, and how it shows them.
 * `pages` are what a hand-picked list chooses from, keyed as the wiki keys
 * them; `sections` the sections a list may name, else a section is typed.
 * A wiki with a source of its own passes it in `sources` and draws its fields
 * as `children`, which show while it is chosen; `show` is then the wiki's own.
 */
export function ListFields<B extends { source: string; under?: string; count?: number; pages?: string[]; show: 'links' | 'cards' }>({
  block,
  onUpdate,
  pages,
  sections,
  sources = [],
  children,
}: {
  block: B;
  onUpdate: (block: B) => void;
  pages?: readonly PageOption[];
  sections?: readonly { value: string; label: string }[];
  sources?: readonly { value: string; label: string }[];
  children?: ReactNode;
}) {
  const c = useEditorContext().kit.classNames;
  const core = (LIST_SOURCES as readonly string[]).includes(block.source);
  const set = (change: Partial<B>) => onUpdate({ ...block, ...change });
  const section = (label: string) =>
    sections ? (
      <Choice label={label} value={block.under ?? ''} options={[{ value: '', label: 'The whole wiki' }, ...sections]} onChange={under => set({ under: under || undefined } as Partial<B>)} />
    ) : (
      <Field label={label}>
        <TextInput label={label} optional value={block.under} onChange={under => set({ under: under?.trim().replace(/^\/+|\/+$/g, '') || undefined } as Partial<B>)} />
      </Field>
    );
  return (
    <div className={c.stack}>
      <Choice
        label="Which pages"
        value={block.source}
        options={[...LIST_SOURCES.map(v => ({ value: v, label: LIST_SOURCE_LABELS[v] })), ...sources]}
        onChange={source =>
          set({
            source,
            ...(source === 'newest' && !block.count && { count: 5 }),
            ...(source === 'chosen' && !block.pages && { pages: [] }),
          } as Partial<B>)
        }
      />
      {block.source === 'under' && section('The section')}
      {block.source === 'newest' && (
        <>
          <LimitField value={block.count} onChange={count => set({ count } as Partial<B>)} />
          {section('From the section')}
        </>
      )}
      {block.source === 'chosen' && <PagePicker ids={block.pages ?? []} onChange={p => set({ pages: p } as Partial<B>)} pages={pages} />}
      {core ? <Choice label="Shown" value={block.show} options={LIST_SHOWS} onChange={show => set({ show } as Partial<B>)} /> : children}
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
