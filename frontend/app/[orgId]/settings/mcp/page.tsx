import McpServersSettings from '@/components/common/settings/mcp-servers';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function Page() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <div className="px-6 py-6">
            <McpServersSettings />
         </div>
      </MainLayout>
   );
}
