import Agents from '@/components/common/agents/agents';
import Header from '@/components/layout/headers/agents/header';
import MainLayout from '@/components/layout/main-layout';

export default function AgentsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={2}>
         <Agents />
      </MainLayout>
   );
}
