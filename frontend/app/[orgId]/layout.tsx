export default function OrgLayout({
   children,
   drawer,
}: {
   children: React.ReactNode;
   drawer: React.ReactNode;
}) {
   return (
      <>
         {children}
         {drawer}
      </>
   );
}
