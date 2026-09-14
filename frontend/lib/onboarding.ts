import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Where somebody is in first-run setup, kept on the account.
 *
 * The server has modelled this all along and nothing used it, so a person who
 * got halfway through and closed the tab started again. It is on the account
 * rather than in the browser because signing in on a second machine should not
 * mean being welcomed twice.
 *
 * `complete` is the end state for both finishing and skipping; `skipped`
 * records which of the two it was, so the difference stays visible without
 * being a second way of being unfinished.
 */
export const ONBOARDING_STEPS = ['welcome', 'aboutYou', 'workspace', 'complete'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The answers the server accepts. Anything else is refused. */
export const ONBOARDING_ANSWER_KEYS = ['role', 'teamSize', 'goal', 'source'] as const;
export type OnboardingAnswerKey = (typeof ONBOARDING_ANSWER_KEYS)[number];

const onboardingSchema = z.object({
   version: z.number(),
   step: z.string(),
   answers: z.record(z.string(), z.string()).nullish(),
   skipped: z.boolean(),
   completed: z.boolean(),
});
export type OnboardingState = z.infer<typeof onboardingSchema>;

export async function loadOnboarding(): Promise<OnboardingState> {
   const parsed = onboardingSchema.safeParse(await apiFetch('/api/v1/me/onboarding'));
   if (!parsed.success) throw new Error('Onboarding response was not recognized');
   return parsed.data;
}

export async function saveOnboarding(patch: {
   step?: OnboardingStep;
   answers?: Partial<Record<OnboardingAnswerKey, string>>;
   skipped?: boolean;
   completed?: boolean;
}): Promise<OnboardingState> {
   const parsed = onboardingSchema.safeParse(
      await apiFetch('/api/v1/me/onboarding', { method: 'PATCH', body: JSON.stringify(patch) })
   );
   if (!parsed.success) throw new Error('Onboarding response was not recognized');
   return parsed.data;
}
