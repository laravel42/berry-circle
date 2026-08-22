export interface LabelInterface {
   id: string;
   name: string;
   color: string;
}

/** Workspace labels. Empty until the gateway provides them. */
export const labels: LabelInterface[] = [];
