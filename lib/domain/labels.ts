export interface LabelInterface {
   id: string;
   name: string;
   color: string;
}

/** Populated via the gateway API at runtime. */
export const labels: LabelInterface[] = [];
