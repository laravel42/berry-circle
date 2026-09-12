/**
 * Berry's keyboard shortcuts: what they are, how a key event becomes one, and
 * what a person is allowed to remap them to.
 *
 * One module so there is one answer. Before this, a shortcut was whatever
 * window listener happened to be mounted, which meant nobody could see the
 * whole set, two areas could bind the same keys without noticing, and nothing
 * could be remapped. Here an action is declared once — id, group, default
 * combination, and the two context rules that decide when it may fire — and
 * the areas that own the behaviour register a handler for it at runtime
 * (`useShortcut` in `components/layout/shortcut-provider.tsx`).
 *
 * Everything in this file is pure. The provider does the listening, the store
 * (`store/shortcuts-store.ts`) does the remembering.
 */

/** The two lists the settings page shows. */
export type ShortcutGroup = 'general' | 'navigation';

export interface ShortcutDefinition {
   /** Stable id: the key handlers register under and bindings persist against. */
   id: string;
   group: ShortcutGroup;
   /** Key under `navigation.shortcuts.actions` in the message catalogues. */
   labelKey: string;
   /**
    * The combination this action starts with. Null means registered but
    * unbound: it appears in settings, it can be given a key, and until then
    * nothing fires it. Every go-to action ships this way.
    */
   defaultCombo: string | null;
   /**
    * Browser-level or shell-level and not remappable. Shown on the settings
    * page as a read-only list so people can see why a key is taken.
    */
   fixed?: boolean;
   /** Fires even when a text field has focus. Off unless stated. */
   allowInInput?: boolean;
   /** Suppressed while a dialog is open. On unless stated otherwise. */
   blockedByModal?: boolean;
}

/**
 * `mod` is the platform's command key: ⌘ on Apple hardware, Ctrl elsewhere.
 * Stored rather than resolved so one stored binding means the same thing on
 * both, and a person who moves machines keeps their shortcuts.
 */
export const MOD = 'mod';

/** Order modifiers are written in, so two spellings of one combo compare equal. */
const MODIFIER_ORDER = [MOD, 'ctrl', 'alt', 'shift'] as const;

/**
 * The default set.
 *
 * `general` is what you do where you are; `navigation` is where you go. The
 * go-to actions are deliberately unbound: they exist so another area can
 * register the destination and a person can give it a key, without Berry
 * claiming a letter nobody asked it to claim.
 */
export const SHORTCUTS: ShortcutDefinition[] = [
   { id: 'issue.create', group: 'general', labelKey: 'createIssue', defaultCombo: 'c' },
   {
      id: 'sidebar.toggle',
      group: 'general',
      labelKey: 'toggleSidebar',
      defaultCombo: 'mod+b',
      allowInInput: true,
   },
   {
      id: 'rightSidebar.toggle',
      group: 'general',
      labelKey: 'toggleRightSidebar',
      defaultCombo: 'mod+/',
      allowInInput: true,
   },
   {
      id: 'chat.toggleFloating',
      group: 'general',
      labelKey: 'toggleFloatingChat',
      defaultCombo: 'mod+j',
      allowInInput: true,
   },
   {
      id: 'issue.find',
      group: 'general',
      labelKey: 'findInIssue',
      defaultCombo: 'mod+f',
      allowInInput: true,
   },
   {
      id: 'inbox.archive',
      group: 'general',
      labelKey: 'archiveInboxItem',
      defaultCombo: 'e',
      // The inbox is a drawer, and a drawer is a dialog. Blocking this one
      // while a dialog is open would mean it never fired at all.
      blockedByModal: false,
   },
   {
      id: 'composer.send',
      group: 'general',
      labelKey: 'send',
      defaultCombo: 'mod+enter',
      allowInInput: true,
      blockedByModal: false,
   },
   {
      id: 'history.back',
      group: 'navigation',
      labelKey: 'back',
      defaultCombo: 'mod+[',
      allowInInput: true,
   },
   {
      id: 'history.forward',
      group: 'navigation',
      labelKey: 'forward',
      defaultCombo: 'mod+]',
      allowInInput: true,
   },
   { id: 'goto.myIssues', group: 'navigation', labelKey: 'goToMyIssues', defaultCombo: null },
   { id: 'goto.inbox', group: 'navigation', labelKey: 'goToInbox', defaultCombo: null },
   { id: 'goto.chat', group: 'navigation', labelKey: 'goToChat', defaultCombo: null },
   { id: 'goto.projects', group: 'navigation', labelKey: 'goToProjects', defaultCombo: null },
   { id: 'goto.goals', group: 'navigation', labelKey: 'goToGoals', defaultCombo: null },
   { id: 'goto.reviews', group: 'navigation', labelKey: 'goToReviews', defaultCombo: null },
   { id: 'goto.views', group: 'navigation', labelKey: 'goToViews', defaultCombo: null },
   { id: 'goto.agents', group: 'navigation', labelKey: 'goToAgents', defaultCombo: null },
   { id: 'goto.runtimes', group: 'navigation', labelKey: 'goToRuntimes', defaultCombo: null },
   { id: 'goto.settings', group: 'navigation', labelKey: 'goToSettings', defaultCombo: null },
];

/**
 * Shortcuts the shell owns and will not give up, listed so the settings page
 * can show them and the conflict check can refuse them. They are not in
 * `SHORTCUTS` because nothing registers a handler for them here — the palette
 * and the tab strip handle their own keys.
 */
export const FIXED_SHORTCUTS: { labelKey: string; combo: string }[] = [
   { labelKey: 'commandPalette', combo: 'mod+k' },
   { labelKey: 'closeOverlay', combo: 'escape' },
   { labelKey: 'newTab', combo: 'ctrl+t' },
   { labelKey: 'closeTab', combo: 'ctrl+w' },
   { labelKey: 'nextTab', combo: 'ctrl+tab' },
];

const BY_ID = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function shortcutById(id: string): ShortcutDefinition | undefined {
   return BY_ID.get(id);
}

/** True on Apple hardware, where `mod` is ⌘ and the display glyphs differ. */
export function isApplePlatform(): boolean {
   if (typeof navigator === 'undefined') return false;
   return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/**
 * A combination in canonical form: modifiers in a fixed order, lower case,
 * joined with `+`. Two people describing one chord get one string, which is
 * what makes conflict detection a map lookup.
 */
export function normalizeCombo(combo: string): string {
   const parts = combo
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part !== '');
   const key = parts.find(
      (part) => !(MODIFIER_ORDER as readonly string[]).includes(part) && part !== 'meta'
   );
   const modifiers = MODIFIER_ORDER.filter(
      (modifier) => parts.includes(modifier) || (modifier === MOD && parts.includes('meta'))
   );
   return [...modifiers, key ?? ''].filter(Boolean).join('+');
}

/** How a key event names itself, or null when only modifiers are held. */
export function comboFromEvent(event: KeyboardEvent): string | null {
   const key = event.key;
   if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;

   const parts: string[] = [];
   // ⌘ and Ctrl both spell `mod`, so one binding works on either platform.
   if (event.metaKey || event.ctrlKey) parts.push(MOD);
   if (event.altKey) parts.push('alt');
   if (event.shiftKey) parts.push('shift');
   parts.push(keyName(key));
   return normalizeCombo(parts.join('+'));
}

/**
 * The stored name of a physical key.
 *
 * Shift is already carried as a modifier, so the *unshifted* meaning is what
 * is stored: otherwise `mod+shift+/` would record itself as `mod+shift+?` on
 * one layout and `mod+shift+/` on another and the two would never match.
 */
function keyName(key: string): string {
   if (key === ' ') return 'space';
   if (key.length === 1) return key.toLowerCase();
   return key.toLowerCase();
}

const APPLE_GLYPHS: Record<string, string> = {
   mod: '⌘',
   ctrl: '⌃',
   alt: '⌥',
   shift: '⇧',
   enter: '↵',
   escape: '⎋',
   backspace: '⌫',
   arrowup: '↑',
   arrowdown: '↓',
   arrowleft: '←',
   arrowright: '→',
};

const OTHER_NAMES: Record<string, string> = {
   mod: 'Ctrl',
   ctrl: 'Ctrl',
   alt: 'Alt',
   shift: 'Shift',
   enter: 'Enter',
   escape: 'Esc',
   backspace: 'Backspace',
   arrowup: '↑',
   arrowdown: '↓',
   arrowleft: '←',
   arrowright: '→',
};

/** A combination as a person reads it: `⌘K` on a Mac, `Ctrl+K` elsewhere. */
export function formatCombo(combo: string, apple = isApplePlatform()): string {
   const parts = combo.split('+').map((part) => {
      const mapped = apple ? APPLE_GLYPHS[part] : OTHER_NAMES[part];
      if (mapped) return mapped;
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
   });
   return apple ? parts.join('') : parts.join('+');
}

/**
 * Combinations the browser keeps for itself. Binding one of these produces a
 * shortcut that either never fires or closes the tab, so the settings page
 * refuses them rather than letting someone discover it the hard way.
 */
const RESERVED = new Set(
   [
      'mod+t',
      'mod+n',
      'mod+w',
      'mod+q',
      'mod+r',
      'mod+l',
      'mod+d',
      'mod+p',
      'mod+s',
      'mod+shift+t',
      'mod+shift+n',
      'mod+shift+w',
      'mod+shift+q',
      'mod+shift+r',
      'mod+alt+i',
      'mod+tab',
      'alt+tab',
      'alt+f4',
      'f5',
      'f11',
      'f12',
   ].map(normalizeCombo)
);

/**
 * Keys that mean something while typing, and so may not be bound bare. With a
 * modifier they are fine — it is the naked Backspace, Space or arrow that
 * would eat a keystroke in every text field in the product.
 */
const TYPING_KEYS = new Set([
   'backspace',
   'delete',
   'space',
   'enter',
   'tab',
   'escape',
   'arrowup',
   'arrowdown',
   'arrowleft',
   'arrowright',
   'home',
   'end',
   'pageup',
   'pagedown',
]);

export type ComboProblem =
   | { kind: 'reserved' }
   | { kind: 'typing' }
   | { kind: 'conflict'; shortcutId: string }
   | { kind: 'fixed'; labelKey: string };

/**
 * Why this combination cannot be given to this action, or null when it can.
 *
 * `bindings` is the resolved map of every action's current combination, so a
 * conflict names the action already holding the keys rather than saying only
 * that something does.
 */
export function comboProblem(
   combo: string,
   forId: string,
   bindings: Record<string, string | null>
): ComboProblem | null {
   const normalized = normalizeCombo(combo);
   if (normalized === '') return { kind: 'typing' };
   if (RESERVED.has(normalized)) return { kind: 'reserved' };

   const parts = normalized.split('+');
   const key = parts[parts.length - 1];
   const bare = parts.length === 1;
   if (bare && TYPING_KEYS.has(key)) return { kind: 'typing' };

   const fixed = FIXED_SHORTCUTS.find((entry) => normalizeCombo(entry.combo) === normalized);
   if (fixed) return { kind: 'fixed', labelKey: fixed.labelKey };

   for (const [id, bound] of Object.entries(bindings)) {
      if (id === forId || !bound) continue;
      if (normalizeCombo(bound) === normalized) return { kind: 'conflict', shortcutId: id };
   }
   return null;
}

/** Defaults, as the map the provider and the settings page both read. */
export function defaultBindings(): Record<string, string | null> {
   const bindings: Record<string, string | null> = {};
   for (const shortcut of SHORTCUTS) {
      bindings[shortcut.id] = shortcut.defaultCombo ? normalizeCombo(shortcut.defaultCombo) : null;
   }
   return bindings;
}

/**
 * Defaults with the person's overrides applied.
 *
 * An override of `null` is a deliberately disabled shortcut, which is not the
 * same as "no override" — hence the `in` check rather than a falsy one.
 */
export function resolveBindings(
   overrides: Record<string, string | null>
): Record<string, string | null> {
   const bindings = defaultBindings();
   for (const id of Object.keys(bindings)) {
      if (id in overrides) {
         const value = overrides[id];
         bindings[id] = value ? normalizeCombo(value) : null;
      }
   }
   return bindings;
}

/** The action a combination fires, or null when nothing holds it. */
export function shortcutForCombo(
   combo: string,
   bindings: Record<string, string | null>
): ShortcutDefinition | null {
   for (const [id, bound] of Object.entries(bindings)) {
      if (bound && bound === combo) {
         const definition = BY_ID.get(id);
         if (definition) return definition;
      }
   }
   return null;
}
