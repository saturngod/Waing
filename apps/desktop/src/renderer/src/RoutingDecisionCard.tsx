import type { AutoSelection } from "@waing/domain";

const roleLabels = {
  planning: "Planning",
  low: "Low Level Task", medium: "Medium Level Task", high: "High Level Task",
  review: "Review Level Task", bugfix: "Bug Fixing Task", document: "Document Task",
} as const;

export function RoutingDecisionCard({ selection }: { selection: AutoSelection }) {
  const decision = selection.status === "resolved" ? selection.resolution.routingDecision : selection.decision;
  const role = selection.status === "resolved" ? selection.resolution.role : selection.suggestedRole;
  return (
    <section className="routing-card" aria-label="Routing decision">
      <div className="routing-heading"><span>Auto route</span><strong>{roleLabels[role]}</strong></div>
      <dl>
        <div><dt>Complexity</dt><dd>{decision.complexity}</dd></div>
        <div><dt>Task</dt><dd>{decision.taskType}</dd></div>
        <div><dt>Mode</dt><dd>{decision.mode}</dd></div>
        <div><dt>Confidence</dt><dd>{Math.round(decision.confidence * 100)}%</dd></div>
      </dl>
      <p>{decision.rationale}</p>
      {selection.status === "needs_confirmation" && <p className="routing-warning">Confirm this route before execution.</p>}
    </section>
  );
}
