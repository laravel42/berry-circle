import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
   baseDirectory: __dirname,
});

/* A Tailwind font-size utility -- the named scale or an arbitrary length --
   with any variant prefixes (`md:`, `file:`, `[&_svg]:`) in front of it.
   Colour utilities such as `text-muted-foreground` and layout ones such as
   `text-balance` deliberately fall outside it. */
const FONT_SIZE_UTILITY = String.raw`(^|\s)([^\s]*:)?text-(xs|sm|base|lg|xl|[2-9]xl|\[[0-9.]+(px|rem|em|pt)\])(\s|$)`;

/* Type size is decided by the element, in the base layer of app/globals.css:
   h1 text-xl, h2 text-lg, h3 text-base, h4 text-sm, everything else text-xs.
   Utilities live in a later cascade layer, so a single `text-lg` in a
   component silently outranks that whole scheme -- which is why none are
   allowed rather than only the wrong ones. Reach for the right element
   instead; if a case genuinely needs its own size, it belongs in globals.css
   next to the rest of the scale, not inline. */
const TYPE_SCALE_MESSAGE =
   'Font sizes come from the element (h1-h4, else text-xs) via the base layer in app/globals.css. Use the right element, or add the exception to globals.css -- do not set a text-* size utility here.';

const eslintConfig = [
   ...compat.extends('next/core-web-vitals', 'next/typescript'),
   {
      files: ['**/*.{ts,tsx}'],
      rules: {
         'no-restricted-syntax': [
            'error',
            {
               selector: `Literal[value=/${FONT_SIZE_UTILITY}/]`,
               message: TYPE_SCALE_MESSAGE,
            },
            {
               selector: `TemplateElement[value.raw=/${FONT_SIZE_UTILITY}/]`,
               message: TYPE_SCALE_MESSAGE,
            },
         ],
      },
   },
   {
      // Vendored bazza/ui data-table-filter (kept close to upstream for easy updates)
      files: ['components/data-table-filter/**/*.{ts,tsx}'],
      rules: {
         '@typescript-eslint/no-unused-vars': 'off',
         '@typescript-eslint/no-explicit-any': 'off',
         '@typescript-eslint/no-this-alias': 'off',
         'react-hooks/rules-of-hooks': 'off',
         'react-hooks/exhaustive-deps': 'off',
      },
   },
];

export default eslintConfig;
