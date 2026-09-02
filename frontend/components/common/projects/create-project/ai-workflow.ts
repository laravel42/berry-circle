import type { User } from '@/data/users';

/**
 * The lead that means Berry runs this project rather than a person.
 *
 * It is not a workspace member and is never sent to the server — picking it is
 * what turns creating a project into planning one, which is why it sits in the
 * same list as the people rather than behind a separate button.
 */
export const AI_WORKFLOW_LEAD: User = {
   id: 'berry:ai-workflow',
   name: 'AI workflow',
   avatarUrl: '',
   email: '',
   status: 'online',
   role: 'Application',
   joinedDate: '',
   teamIds: [],
   timezone: 'UTC',
};

export function isAiWorkflow(lead: User | undefined): boolean {
   return lead?.id === AI_WORKFLOW_LEAD.id;
}
