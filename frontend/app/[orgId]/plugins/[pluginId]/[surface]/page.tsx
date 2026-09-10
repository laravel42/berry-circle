import PluginSurface from '@/components/common/plugins/plugin-surface';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function PluginSurfacePage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <div className="h-full min-h-0 overflow-hidden">
            <PluginSurface />
         </div>
      </MainLayout>
   );
}
