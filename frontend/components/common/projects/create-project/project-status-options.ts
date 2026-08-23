import {
   CancelledIcon,
   DoneIcon,
   InProgressIcon,
   PausedIcon,
   ToDoIcon,
   type Status,
} from '@/data/status';

export interface ProjectCreateStatusOption {
   status: Status;
   label: string;
}

const projectPausedStatus: Status = {
   id: 'paused',
   name: 'Paused',
   color: '#6A6767',
   category: 'started',
   icon: PausedIcon,
};

const PROJECT_STATUS_OPTIONS: ProjectCreateStatusOption[] = [
   {
      status: {
         id: 'to-do',
         name: 'Todo',
         color: '#6A6767',
         category: 'unstarted',
         icon: ToDoIcon,
      },
      label: 'Planned',
   },
   {
      status: {
         id: 'in-progress',
         name: 'In Progress',
         color: '#5A92C9',
         category: 'started',
         icon: InProgressIcon,
      },
      label: 'Active',
   },
   { status: projectPausedStatus, label: 'Paused' },
   {
      status: { id: 'done', name: 'Done', color: '#4F9F7A', category: 'completed', icon: DoneIcon },
      label: 'Completed',
   },
   {
      status: {
         id: 'cancelled',
         name: 'Cancelled',
         color: '#D9A441',
         category: 'canceled',
         icon: CancelledIcon,
      },
      label: 'Cancelled',
   },
];

export const projectCreateStatusOptions: ProjectCreateStatusOption[] = PROJECT_STATUS_OPTIONS;

export const defaultProjectCreateStatus =
   projectCreateStatusOptions.find((option) => option.status.id === 'to-do') ??
   projectCreateStatusOptions[0];
