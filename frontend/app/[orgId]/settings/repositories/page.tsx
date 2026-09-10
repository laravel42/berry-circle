import RepositoriesSettings from '@/components/common/settings/repositories-settings';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function RepositoriesSettingsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <RepositoriesSettings />
      </MainLayout>
   );
}
