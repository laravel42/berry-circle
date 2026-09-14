import AutopilotDetail from '@/components/common/autopilots/autopilot-detail';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ orgId: string; autopilotId: string }>;
}

export default async function AutopilotPage({ params }: Props) {
   const { autopilotId } = await params;
   return (
      <MainLayout>
         <AutopilotDetail autopilotId={autopilotId} />
      </MainLayout>
   );
}
