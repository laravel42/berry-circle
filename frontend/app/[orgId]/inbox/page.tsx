import Inbox from '@/components/common/inbox/inbox';
import { InboxHeader } from '@/components/common/inbox/inbox-header';
import MainLayout from '@/components/layout/main-layout';

export default function InboxPage() {
   return (
      <MainLayout header={<InboxHeader />}>
         <Inbox />
      </MainLayout>
   );
}
