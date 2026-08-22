import { User } from './users';

export interface TeamDocument {
   id: string;
   name: string;
   icon: string;
   creator: User;
   createdAt: string; // ISO date
   updatedAt: string; // ISO date
   pinned?: boolean;
}

export interface DocumentFolder {
   id: string;
   name: string;
   icon: string;
   documents: TeamDocument[];
}

/** Populated via the gateway API at runtime. */
export const documentFolders: DocumentFolder[] = [];

/** Flatten all documents across folders (populated at runtime). */
export function getAllDocuments(): TeamDocument[] {
   return documentFolders.flatMap((folder) => folder.documents);
}
