import WorkspaceGeneral from '@/components/common/settings/workspace-general';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function Page() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <WorkspaceGeneral />
      </MainLayout>
   );
}
