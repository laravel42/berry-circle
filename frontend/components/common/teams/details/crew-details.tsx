interface CrewDetailsProps {
   teamId: string;
}

/**
 * Crew detail body. Header carries identity; the pane is empty for now.
 *
 * The crew id is surfaced as a data attribute rather than discarded, so the
 * pane is addressable in tests and in the DOM while its content is pending.
 */
export default function CrewDetails({ teamId }: CrewDetailsProps) {
   return <div data-crew-id={teamId} className="h-full min-h-0 w-full bg-container" />;
}
