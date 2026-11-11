import type { Approach } from "@explanimate/core";

/**
 * The shape of the video, chosen from the approach the brief picked. Until now every source got the
 * same six beats (hook, one scene per part, one walkthrough, a scale scene, a recap headed "the whole
 * trip") and the same hotel-front-desk analogy, so a DNS explainer and a web-analytics explainer came
 * out looking like the same video with different labels. The shape decides the opening move, how the
 * parts are introduced, whether there is an analogy at all, and where the video stops.
 */
export type Shape = "journey" | "build" | "fault";

/** The hook line a journey video opens on: the "What if your AI could..." question the approved sample uses. */
export const WHAT_IF = /^what if\b/i;

export interface ShapeSpec {
  /** what the first scene does */
  hook: string;
  /** how the scenes that introduce the parts are framed */
  spine: string;
  /** how the video ends, and whether there is a recap at all */
  close: string;
  /** heading style, with examples the narration has to actually say */
  headings: string;
  /** whether the everyday analogy is used, optional, or left out */
  analogy: "required" | "optional" | "none";
  recap: boolean;
}

export const SHAPES: Record<Shape, ShapeSpec> = {
  journey: {
    analogy: "optional",
    hook: "Sentence one is the hook, shown on the title card under the name and tagline: a 'What if ...?' question about what this lets you (or your AI, your app) do; or, when the subject is not something you operate, a direct question about the payoff ('How does one file turn into answers you can trust?'); at most 14 words, spoken within about 8 seconds, no product name ('What if your AI could really click around the web?'). Then one or two short lines on what that means in practice, said as the contrast with today ('Not guess what a page says. Actually open it, read it, and press the button.'). Then what the product is, in one plain sentence that names it and the familiar tools it works with ('That's agent-browser: a command-line tool that lets an AI agent, like Claude Code or Cursor, drive a real Chrome browser.'). No part names yet.",
    spine:
      "Tell it in the order things happen ('First...', 'Next...'): each scene is the next thing that happens, said literally, and the part that does it. For each added part, first the problem it solves in one short line (what would be slow, hard or impossible without it), then the part by its keyword, what it is in one plain clause, and what that buys you (plus its role in the analogy, only if the video has one).",
    close:
      "End with one recap scene of two or three short plain sentences. First answer 'so what does it do for me?' for the viewer, in everyday words ('So your AI can log in, fill a form or grab a screenshot for you, in a real browser.'). Then retell what happened in one short literal sentence, naming the journey keywords in order the way you'd tell a friend, not as a list of steps, and if it fits, one line that answers the hook's question. Give it a plain heading that says what you get, like 'what you get'.",
    headings:
      "Plain and literal, in the words the narration says: 'where it starts', 'what runs the page', 'when lots of jobs come in'. Never a metaphor or a generic summary heading.",
    recap: true,
  },
  build: {
    analogy: "optional",
    hook: "Sentence one is the hook: the one small thing that already works here, said as a concrete claim about the viewer's payoff ('one file, and you already get answers'), at most 14 words, spoken within about 8 seconds, no product name needed. Then the limit of that small thing, in plain words, and the promise: what has to be added, and why. No analogy unless one genuinely comes from the project's own world.",
    spine:
      "Each scene adds the next part because the scene before it hit a specific limit. Say the limit first, as a problem the viewer can feel ('one process is fine until the second writer arrives'), then add the part that lifts it and say what it buys. The parts arrive in the order the limits appear, not the order they are listed in the architecture.",
    close:
      "Do not recap every step. End on the walkthrough's payoff: the thing this system can do now that the first small version could not, in one sentence for 'you', then one short sentence retracing the limits lifted in order, and stop.",
    headings:
      "Plain and literal, naming the limit or the gain, not the part: 'it works once', 'the second writer', 'now it queues'. Never a metaphor.",
    recap: false,
  },
  fault: {
    analogy: "none",
    hook: "Sentence one is the hook: the pain, in the second person and concrete, at most 14 words, spoken within about 8 seconds ('your dashboard takes nine seconds to open'), then what that pain costs and what this project does about it. No analogy: the pain is the through-line.",
    spine:
      "Each scene removes one piece of the pain: name what hurts at that point (slow, lost, wrong, down), then the part that removes it and what changes for the viewer because of it. The parts arrive in the order the pain is felt.",
    close:
      "End with one short closing scene: the same moment from the hook, now without the pain, in one breath ('the dashboard opens, from the first chart to the last, in under a second'). Pay off the hook's number or claim, then stop.",
    headings: "Name the pain and its removal: 'nine seconds', 'nothing is lost', 'it waits its turn'. Never a tour heading.",
    recap: true,
  },
};

/** story and step-by-step are both one thing moving through the system; build-up adds parts; the rest start from a pain. */
export function shapeFor(approach: Approach): Shape {
  if (approach === "build-up") return "build";
  if (approach === "problem-solution" || approach === "compare") return "fault";
  return "journey";
}

/** The analogy rule for a shape, so no shape falls back to the three standbys. */
export function analogyRule(shape: Shape, analogy: string): string {
  const banned =
    "Never a hotel front desk, a post office, a restaurant kitchen or a mailroom unless the source is literally about one of those.";
  if (shape === "fault") return `No everyday analogy in this video: the pain carries it. ${banned}`;
  if (!analogy)
    return `No everyday analogy. Say the real parts by their real names; this subject is concrete enough without one. ${banned}`;
  return `Everyday analogy, used lightly: ${analogy}. Give it one sentence in the hook and at most a light callback on the journey; do not dress every part in it, and say the real name each time you use it. It must be concrete and familiar (a place the viewer has stood in or a tool they have used) from the world this project serves, not from the standbys. ${banned}`;
}
