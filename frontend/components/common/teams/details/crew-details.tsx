interface CrewDetailsProps {
   teamId: string;
}

/** Crew detail body. Header carries identity; the pane is empty for now. */
export default function CrewDetails({ teamId: _teamId }: CrewDetailsProps) {
   return <div className="h-full min-h-0 w-full bg-container" />;
}
