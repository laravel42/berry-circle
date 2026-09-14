import { Status } from './status';
import { RemixiconComponentType } from '@remixicon/react';
import type { LucideIcon } from 'lucide-react';
import { User } from './users';
import { LabelInterface } from './labels';
import { Priority } from './priorities';

export interface Project {
   id: string;
   name: string;
   status: Status;
   icon: LucideIcon | RemixiconComponentType;
   percentComplete: number;
   startDate: string;
   /** Planned completion date (Linear "Target date"). */
   targetDate?: string;
   lead: User;
   priority: Priority;
   health: Health;
   /** Owning team (see data/teams.ts). */
   teamId: string;
   labels: LabelInterface[];
   initiative?: string;
   /** Days since the last health update (undefined = no update yet). */
   healthUpdatedAgoDays?: number;
   /** GitHub repository this project delivers into, as owner/name. */
   githubRepo?: string;
   /** What the project is for, as stored. Plain text with light markdown. */
   description?: string;
}

export interface Health {
   id: 'no-update' | 'off-track' | 'on-track' | 'at-risk';
   name: string;
   color: string;
   description: string;
}

export const health: Health[] = [
   {
      id: 'no-update',
      name: 'No Update',
      color: '#8f9299',
      description: 'The project has not been updated in the last 30 days.',
   },
   {
      id: 'off-track',
      name: 'Off Track',
      color: '#eb5757',
      description: 'The project is not on track and may be delayed.',
   },
   {
      id: 'on-track',
      name: 'On Track',
      color: '#4cb782',
      description: 'The project is on track and on schedule.',
   },
   {
      id: 'at-risk',
      name: 'At Risk',
      color: '#f2c94c',
      description: 'The project is at risk and may be delayed.',
   },
];
