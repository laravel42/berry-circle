import React from 'react';

import { cn } from '@/lib/utils';

interface IconProps extends React.SVGProps<SVGSVGElement> {
   className?: string;
}

/**
 * Colour by urgency tier, from the semantic status tokens rather than raw brand
 * values, so the tiers follow the palette in both themes.
 *
 * Only the top two tiers take an alert colour. If every tier were coloured
 * nothing would stand out, and the icons already encode the lower tiers through
 * the height and opacity of their bars — the colour reinforces that ordering
 * rather than competing with it.
 *
 * The remaining three descend by opacity on one colour rather than by picking
 * three greys. The palette's neutrals do not order consistently: muted is
 * #5d5a5a on light and ash on dark, while status-neutral is slate in both, so
 * muted reads as the more prominent of the pair against either background and a
 * ladder built from them inverts at the bottom. Alpha on a single token
 * descends by construction, whichever theme is active.
 *
 * Medium deliberately does not use foreground. At roughly 16:1 against either
 * background it would be the highest-contrast thing on the row — louder than
 * urgent — which is the opposite of what a tier scale should say.
 *
 * The alpha range is tighter than it looks like it should be because the
 * faintest step still has to clear 3:1 against both backgrounds. A priority
 * icon is the only thing stating the tier in a dense row, so it is meaningful
 * non-text content rather than decoration, and fading it further would put the
 * lowest tiers below the floor.
 *
 * Applied after the caller's className, deliberately. A priority icon's colour
 * states how urgent the issue is, which is meaning rather than decoration, and
 * most call sites passed text-muted-foreground only because there was no colour
 * to show. Ordering it last means every site is correct without being edited,
 * and a new one cannot forget.
 */
const tone = {
   urgent: 'text-status-danger',
   high: 'text-status-warning',
   medium: 'text-muted-foreground',
   low: 'text-muted-foreground/85',
   none: 'text-muted-foreground/70',
} as const;

const NoPriorityIcon = ({ className, ...props }: IconProps) => (
   <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn(className, tone.none)}
      aria-label="No Priority"
      role="img"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
   >
      <rect x="1.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9"></rect>
      <rect x="6.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9"></rect>
      <rect x="11.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9"></rect>
   </svg>
);

const UrgentPriorityIcon = ({ className, ...props }: IconProps) => (
   <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn(className, tone.urgent)}
      aria-label="Urgent Priority"
      role="img"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
   >
      <path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z"></path>
   </svg>
);

const HighPriorityIcon = ({ className, ...props }: IconProps) => (
   <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn(className, tone.high)}
      aria-label="High Priority"
      role="img"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
   >
      <rect x="1.5" y="8" width="3" height="6" rx="1"></rect>
      <rect x="6.5" y="5" width="3" height="9" rx="1"></rect>
      <rect x="11.5" y="2" width="3" height="12" rx="1"></rect>
   </svg>
);

const MediumPriorityIcon = ({ className, ...props }: IconProps) => (
   <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn(className, tone.medium)}
      aria-label="Medium Priority"
      role="img"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
   >
      <rect x="1.5" y="8" width="3" height="6" rx="1"></rect>
      <rect x="6.5" y="5" width="3" height="9" rx="1"></rect>
      <rect x="11.5" y="2" width="3" height="12" rx="1" fillOpacity="0.4"></rect>
   </svg>
);

const LowPriorityIcon = ({ className, ...props }: IconProps) => (
   <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn(className, tone.low)}
      aria-label="Low Priority"
      role="img"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
   >
      <rect x="1.5" y="8" width="3" height="6" rx="1"></rect>
      <rect x="6.5" y="5" width="3" height="9" rx="1" fillOpacity="0.4"></rect>
      <rect x="11.5" y="2" width="3" height="12" rx="1" fillOpacity="0.4"></rect>
   </svg>
);

export interface Priority {
   id: string;
   name: string;
   icon: React.FC<React.SVGProps<SVGSVGElement>>;
}

export const priorities: Priority[] = [
   { id: 'no-priority', name: 'No priority', icon: NoPriorityIcon },
   { id: 'urgent', name: 'Urgent', icon: UrgentPriorityIcon },
   { id: 'high', name: 'High', icon: HighPriorityIcon },
   { id: 'medium', name: 'Medium', icon: MediumPriorityIcon },
   { id: 'low', name: 'Low', icon: LowPriorityIcon },
];
