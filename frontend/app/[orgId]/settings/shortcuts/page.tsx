import MainLayout from '@/components/layout/main-layout';
import { KeyboardShortcuts } from '@/components/common/settings/keyboard-shortcuts';
import Header from '@/components/layout/headers/settings/header';

export default function Page() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <KeyboardShortcuts />
      </MainLayout>
   );
}
