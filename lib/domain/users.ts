export interface User {
   id: string;
   name: string;
   avatarUrl: string;
   email: string;
   status: 'online' | 'offline' | 'away';
   role: 'Member' | 'Admin' | 'Guest' | 'Application';
   joinedDate: string;
   teamIds: string[];
   /** IANA timezone, used to display the member's local time. */
   timezone: string;
}

export const statusUserColors: Record<string, string> = {
   online: '#00cc66',
   offline: '#969696',
   away: '#ffcc00',
};

/** Populated via the gateway API at runtime. */
export const users: User[] = [];
