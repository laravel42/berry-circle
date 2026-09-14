import PluginsSettings from '@/components/common/settings/plugins-settings';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginsSettingsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <PluginsSettings />
      </MainLayout>
   );
}
