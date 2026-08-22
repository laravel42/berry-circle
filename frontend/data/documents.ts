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

/** Team documents grouped by folder. Empty until the gateway provides them. */
export const documentFolders: DocumentFolder[] = [];

export function getAllDocuments(): TeamDocument[] {
   return documentFolders.flatMap((folder) => folder.documents);
}
