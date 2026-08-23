interface TeamOverviewProps {
   teamId?: string;
}

/** Team Home — overview tab. Header carries identity; the pane is empty for now. */
export default function TeamOverview({ teamId: _teamId }: TeamOverviewProps) {
   return <div className="h-full min-h-0 w-full bg-container" />;
}
