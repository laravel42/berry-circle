import PluginDetail from '@/components/common/settings/plugin-detail';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginDetailPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <PluginDetail />
      </MainLayout>
   );
}
