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

export const statusUserColors = {
   online: '#00cc66',
   offline: '#969696',
   away: '#ffcc00',
};

/**
 * Placeholder for the signed-in user.
 *
 * A few UI flows (comment composer, issue creation, "My issues") need a
 * current-user identity even before authentication exists. This shim keeps
 * those flows bootable; it is replaced by the gateway's identity API once
 * team/auth wiring lands. Do not build features on top of it.
 */
export const currentUser: User = {
   id: 'me',
   name: 'You',
   avatarUrl: '',
   email: '',
   status: 'online',
   role: 'Admin',
   joinedDate: '1970-01-01',
   teamIds: [],
   timezone: 'UTC',
};
