import { useState } from "react";
import { Check } from "lucide-react";
import type { AgentQuestion, AgentQuestionResponse } from "@waing/domain";

/**
 * An agent asking the user to choose. The provider's run is parked until this is answered, so the card also
 * offers Skip — a deliberate "no answer" is still an answer, and it releases the run.
 */
export function QuestionCard({ question, onAnswer, onDismiss }: {
  question: AgentQuestion;
  onAnswer: (answers: AgentQuestionResponse) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  function valuesFor(header: string): string[] {
    const typed = other[header]?.trim() ?? "";
    return [...picked[header] ?? [], ...(typed.length === 0 ? [] : [typed])];
  }
  function toggle(header: string, label: string, multiSelect: boolean): void {
    setPicked((current) => {
      const existing = current[header] ?? [];
      if (!multiSelect) return { ...current, [header]: existing.includes(label) ? [] : [label] };
      return { ...current, [header]: existing.includes(label)
        ? existing.filter((value) => value !== label) : [...existing, label] };
    });
  }
  const answered = question.questions.every((item) => valuesFor(item.header).length > 0);

  return (
    <section className="question-card" aria-label="Agent question">
      <div className="question-heading"><span>Question</span><span>{question.agentId}</span></div>
      {question.questions.map((item) => (
        <div className="question-block" key={item.header}>
          <h3>{item.question}</h3>
          <p className="question-chip">{item.header}{item.multiSelect === true ? " · choose any" : ""}</p>
          <div className="question-options">
            {item.options.map((option) => {
              const selected = (picked[item.header] ?? []).includes(option.label);
              return (
                <button key={option.label} type="button" className={selected ? "selected" : ""}
                  aria-pressed={selected} onClick={() => toggle(item.header, option.label, item.multiSelect === true)}>
                  <span className="question-tick">{selected && <Check size={13} aria-hidden="true" />}</span>
                  <span><strong>{option.label}</strong>{option.description.length > 0 && <small>{option.description}</small>}</span>
                </button>
              );
            })}
          </div>
          <input type="text" placeholder="Or answer in your own words…" value={other[item.header] ?? ""}
            aria-label={`Other answer for ${item.header}`}
            onChange={(event) => setOther((current) => ({ ...current, [item.header]: event.target.value }))} />
        </div>
      ))}
      <div className="question-actions">
        <button type="button" onClick={onDismiss}>Skip</button>
        <button type="button" className="primary" disabled={!answered}
          onClick={() => onAnswer(question.questions.map((item) => ({ header: item.header, values: valuesFor(item.header) })))}>
          Answer</button>
      </div>
    </section>
  );
}
