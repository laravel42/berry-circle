import { Project } from './projects';
import { User } from './users';

export interface Team {
   id: string;
   /** Short uppercase handle shown beside the crew name (board slug). */
   identifier: string;
   name: string;
   icon: string;
   joined: boolean;
   color: string;
   members: User[];
   /** Agent that receives work assigned to this crew. */
   lead?: User;
   projects: Project[];
   issueCount?: number;
   createdAt?: string;
   updatedAt?: string;
}
