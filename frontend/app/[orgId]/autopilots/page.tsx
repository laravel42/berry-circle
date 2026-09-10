import Autopilots from '@/components/common/autopilots/autopilots';
import Header from '@/components/layout/headers/autopilots/header';
import MainLayout from '@/components/layout/main-layout';

export default function AutopilotsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Autopilots />
      </MainLayout>
   );
}
