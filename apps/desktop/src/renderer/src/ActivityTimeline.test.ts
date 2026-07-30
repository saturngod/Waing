import { describe, expect, it } from "vitest";
import { formatProcessDuration, withoutStateBlock } from "./ActivityTimeline";

describe("process duration", () => {
  it("shows a compact live and completed duration", () => {
    expect(formatProcessDuration(0)).toBe("1s");
    expect(formatProcessDuration(14_999)).toBe("14s");
    expect(formatProcessDuration(60_000)).toBe("1m");
    expect(formatProcessDuration(12 * 60_000 + 59_000)).toBe("12m");
    expect(formatProcessDuration(2 * 60 * 60_000)).toBe("2h");
  });
});

describe("shared-state block stripping", () => {
  it("removes the block whatever fence the provider wrapped it in", () => {
    const state = '{"planItems":[{"id":"p1","title":"Ship it","status":"done"}]}';
    for (const fence of ["```waing-state", "```json", "```"]) {
      expect(withoutStateBlock(`Confidence: High\n\n${fence}\n${state}\n\`\`\``)).toBe("Confidence: High");
    }
    expect(withoutStateBlock(`Confidence: High\n\n${state}`)).toBe("Confidence: High");
  });

  it("leaves no orphaned fence behind, which would render as an empty code block", () => {
    // The closing fence goes with the object, so an unlabelled opening fence has to go too.
    const stripped = withoutStateBlock('Done.\n\n```json\n{"decisions":["use sqlite"]}\n```');
    expect(stripped).not.toContain("```");
    expect(stripped).toBe("Done.");
  });

  it("strips the half-written forms a stream passes through", () => {
    expect(withoutStateBlock('Working.\n\n```waing-state\n{"planItems":[')).toBe("Working.");
    expect(withoutStateBlock('Working.\n\n{"openQuestions":["which db"')).toBe("Working.");
  });

  it("keeps real code blocks, including JSON that is not a state block", () => {
    const code = "Here is the fix.\n\n```ts\nexport const value = 1;\n```\n\nRun the tests.";
    expect(withoutStateBlock(code)).toBe(code);
    const json = 'Config:\n\n```json\n{"other":1}\n```';
    expect(withoutStateBlock(json)).toBe(json);
    // Prose naming a state key must not trigger the bare-object form either.
    const prose = "The planItems list is empty.\n\n```ts\nconst x = 1;\n```";
    expect(withoutStateBlock(prose)).toBe(prose);
  });
});
