/**
 * The Steps Library: predefined, industry-standard step prompts across every
 * domain — not just code. Each prompt is a self-contained brief for a fresh
 * agent: real constraints, the named industry practice, and a definition of
 * done. Searchable + category-filtered in the step picker.
 */

export interface LibraryStep {
  id: string;
  category: string;
  title: string;
  /** the practice it encodes, shown as a small label (e.g. "DRY", "MECE") */
  standard?: string;
  prompt: string;
  model?: "haiku" | "sonnet" | "opus";
  tools?: string[];
  keywords: string[];
}

const READONLY = ["Read", "Grep", "Glob"];
const EDIT = ["Read", "Edit", "Write", "Grep", "Glob"];
const FULL = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const RESEARCH = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];
const WRITE = ["Read", "Write", "Grep", "Glob"];

export const STEP_CATEGORIES = [
  "Coding",
  "Data & Excel",
  "Docs & Slides",
  "Writing",
  "Research",
  "Marketing",
  "Ops & Business",
] as const;

export const STEP_LIBRARY: LibraryStep[] = [
  // ---------------- Coding ----------------
  {
    id: "code-dry",
    category: "Coding",
    title: "DRY sweep — factor out duplication",
    standard: "DRY",
    prompt:
      "Apply Don't Repeat Yourself to this repository. Find logic that exists in more than one place (copy-pasted blocks, parallel implementations, near-identical helpers), and factor each into a single well-named unit that all call sites share. Only merge true duplicates — two things that look alike but change for different reasons stay separate. Keep behavior identical. Done when: each extraction lists the call sites it unified, and the existing tests still pass.",
    model: "sonnet",
    tools: FULL,
    keywords: ["dry", "duplication", "refactor", "dont repeat yourself", "clean code"],
  },
  {
    id: "code-ssot",
    category: "Coding",
    title: "Single source of truth audit",
    standard: "SSOT",
    prompt:
      "Audit this repository for facts defined in more than one place — constants, config values, schemas, enums, URLs, version numbers — anything where two copies could drift apart. For each, pick the canonical home and make every other site derive from it (import, generate, or reference; never re-declare). Done when: you list each fact, its old locations, its new single home, and the build/tests still pass.",
    model: "sonnet",
    tools: FULL,
    keywords: ["single source of truth", "ssot", "config", "constants", "drift"],
  },
  {
    id: "code-solid",
    category: "Coding",
    title: "SOLID review of a module",
    standard: "SOLID",
    prompt:
      "Review the most-changed module in this repository against the SOLID principles. For each violation, name the principle, show the file:line, explain the concrete cost (what change becomes hard, what test becomes impossible), and propose the smallest refactor that fixes it. Do not change code. Done when: every finding has principle + location + cost + minimal fix, ranked by leverage.",
    model: "opus",
    tools: READONLY,
    keywords: ["solid", "srp", "architecture", "review", "design"],
  },
  {
    id: "code-security",
    category: "Coding",
    title: "OWASP-aligned security pass",
    standard: "OWASP",
    prompt:
      "Sweep this codebase for the OWASP Top 10 risk classes that apply to it: injection, broken auth/access control, secrets in code, insecure deserialization, unvalidated input at trust boundaries, SSRF. For each finding give file:line, a concrete exploit scenario, severity, and the precise fix. No theoretical findings — every one needs a plausible attack path. Done when: findings are ranked by severity and each has a fix a developer can apply directly.",
    model: "opus",
    tools: READONLY,
    keywords: ["security", "owasp", "vulnerability", "audit", "injection", "secrets"],
  },
  {
    id: "code-test-pyramid",
    category: "Coding",
    title: "Test-pyramid gap analysis + fill",
    standard: "Test pyramid",
    prompt:
      "Map this repository's tests against the test pyramid: many fast unit tests, fewer integration tests, few end-to-end. Identify the riskiest untested behavior (public APIs, money/data paths, error handling), then write the missing tests, starting at the cheapest layer that can catch each risk. Run them; they must pass — and fail when the behavior is reverted. Done when: you report coverage before/after per layer and every new test's target risk.",
    model: "sonnet",
    tools: FULL,
    keywords: ["tests", "coverage", "test pyramid", "unit", "integration"],
  },
  {
    id: "code-conventional-commits",
    category: "Coding",
    title: "Ship a clean PR (Conventional Commits)",
    standard: "Conventional Commits",
    prompt:
      "Package the current working-tree changes for review: split unrelated changes into separate commits, write each message in Conventional Commits form (type(scope): imperative summary, body explaining why), push a well-named branch, and open a PR whose description covers the problem, the approach, and how it was verified. Done when: the PR exists (report the URL), every commit passes a lint of its message format, and no commit mixes concerns.",
    model: "haiku",
    tools: FULL,
    keywords: ["git", "pr", "commit", "conventional commits", "ship"],
  },

  // ---------------- Data & Excel ----------------
  {
    id: "data-clean",
    category: "Data & Excel",
    title: "Clean & normalize a dataset",
    standard: "Tidy data",
    prompt:
      "Clean the dataset in this project (CSV/XLSX — find it, or ask the run's params). Apply tidy-data rules: one variable per column, one observation per row. Fix types, trim whitespace, normalize dates to ISO 8601, standardize categorical values (map obvious variants like 'NY'/'New York'), flag — never silently drop — duplicates and impossible values (negative ages, future birthdays). Write the cleaned file alongside the original plus a cleaning log. Done when: the log counts every change by rule and the original file is untouched.",
    model: "sonnet",
    tools: FULL,
    keywords: ["excel", "csv", "clean", "dedupe", "normalize", "tidy data", "spreadsheet"],
  },
  {
    id: "data-pivot",
    category: "Data & Excel",
    title: "Pivot analysis with the 'so what'",
    prompt:
      "Analyze the dataset in this project the way a strong analyst builds pivot tables: pick the 2–3 groupings that matter to the business question, compute totals/averages/rates per group, and rank them. For each table, write the one-sentence 'so what' a decision-maker needs. Flag any group too small to trust (n < 30). Done when: each pivot has its takeaway sentence, and the numbers reconcile to the raw totals.",
    model: "sonnet",
    tools: FULL,
    keywords: ["pivot", "excel", "analysis", "aggregate", "groupby", "insight"],
  },
  {
    id: "data-validate",
    category: "Data & Excel",
    title: "Data-quality gate (before anyone trusts it)",
    prompt:
      "Build a data-quality report for the dataset in this project. Check the six standard dimensions: completeness (nulls by column), uniqueness (dupes on the natural key), validity (type/range/format violations), consistency (cross-field contradictions like end<start), accuracy proxies (outliers beyond 3σ, benfordish anomalies in money columns), and timeliness (stale dates). Score each dimension, list the worst offending rows. Done when: a reader knows exactly whether — and where — this data can be trusted.",
    model: "sonnet",
    tools: FULL,
    keywords: ["data quality", "validation", "nulls", "duplicates", "audit", "excel"],
  },

  // ---------------- Docs & Slides ----------------
  {
    id: "slides-outline",
    category: "Docs & Slides",
    title: "Deck outline — one idea per slide",
    standard: "Assertion-evidence",
    prompt:
      "Turn the source material in this project into a presentation outline using the assertion-evidence standard: each slide's title is a full-sentence claim (not a topic word), and its body is only the evidence for that claim. Open with the takeaway (BLUF), 10 slides maximum, one idea per slide, and a closing slide that says exactly what you want the audience to do. Write it as a markdown file, one section per slide with speaker notes. Done when: reading only the slide titles top-to-bottom tells the complete story.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["powerpoint", "slides", "deck", "presentation", "outline", "pitch"],
  },
  {
    id: "docs-exec-summary",
    category: "Docs & Slides",
    title: "Executive summary (BLUF)",
    standard: "BLUF",
    prompt:
      "Write a one-page executive summary of the material in this project using Bottom Line Up Front: the decision or conclusion in the first two sentences, then the three strongest supporting points with their numbers, then risks with mitigations, then the specific ask (who does what by when). No throat-clearing, no 'this document describes'. Done when: a reader who stops after the first paragraph still knows the bottom line and the ask.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["executive summary", "bluf", "memo", "one pager", "leadership"],
  },
  {
    id: "docs-sop",
    category: "Docs & Slides",
    title: "Turn tribal knowledge into an SOP",
    prompt:
      "Document the process evidenced in this project (scripts, notes, history) as a standard operating procedure a competent newcomer could follow alone: purpose, prerequisites, numbered steps each with its expected result, what-can-go-wrong per risky step with recovery, and an escalation contact placeholder. Steps must be verifiable actions ('run X, expect Y'), never vibes ('make sure it looks right'). Done when: every step has an expected result and the doc has been sanity-walked start to finish.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["sop", "process", "documentation", "runbook", "onboarding"],
  },

  // ---------------- Writing ----------------
  {
    id: "write-blog",
    category: "Writing",
    title: "Blog post — hook, substance, one CTA",
    prompt:
      "Write a blog post from the material in this project. Standards: a first sentence that earns the second (concrete, surprising, or useful — never 'In today's world'), one core idea developed with specific evidence and examples, subheads that summarize (a skimmer gets the argument from subheads alone), short paragraphs, and exactly one call to action. 800–1200 words. Done when: the draft passes your own skim-test — subheads tell the story — and contains zero filler sentences you'd cut on a second read.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["blog", "article", "post", "content", "hook"],
  },
  {
    id: "write-edit",
    category: "Writing",
    title: "Editing pass — cut 20%",
    standard: "Strunk: omit needless words",
    prompt:
      "Edit the draft in this project (find the most recent document). Apply the classic standard — omit needless words: cut hedges (very, quite, rather), redundant pairs, throat-clearing openers, and passive voice where the actor matters. Preserve the author's voice and every substantive claim. Target: at least 20% shorter without losing a single fact. Done when: you report before/after word counts and a short list of the patterns you cut most.",
    model: "haiku",
    tools: EDIT,
    keywords: ["edit", "proofread", "concise", "tighten", "copyedit"],
  },
  {
    id: "write-tone",
    category: "Writing",
    title: "Audience-tone rewrite",
    prompt:
      "Rewrite the document in this project for a specified audience (from the run's params, or infer the most likely one and say so). Adjust vocabulary, sentence length, assumed knowledge, and formality — but every fact, number, and commitment must survive the rewrite unchanged. Produce the rewrite plus a three-line note on what you shifted and why. Done when: a fact-by-fact diff against the original shows zero substantive changes.",
    model: "sonnet",
    tools: EDIT,
    keywords: ["tone", "rewrite", "audience", "formal", "simplify"],
  },

  // ---------------- Research ----------------
  {
    id: "research-lit",
    category: "Research",
    title: "Source sweep with citation discipline",
    prompt:
      "Research the question defined for this run. Gather from primary sources first (docs, papers, filings, data) and treat commentary as secondary. Record every claim with its source URL and date, mark each as established fact vs. single-source vs. contested, and note the strongest counter-evidence you found — actively look for it. Done when: the question is answerable from your notes alone, no claim lacks a source, and at least one genuine counter-argument is documented.",
    model: "sonnet",
    tools: RESEARCH,
    keywords: ["research", "sources", "citations", "literature", "facts"],
  },
  {
    id: "research-competitive",
    category: "Research",
    title: "Competitive analysis (MECE)",
    standard: "MECE",
    prompt:
      "Build a competitive analysis for the product/space defined in this run. Structure it MECE — categories that don't overlap and together cover the space. For each competitor: positioning in their own words, pricing, the one thing they do best, their exposed flank, and evidence links. End with the gap map: underserved needs no one covers well. Done when: every cell is sourced, no competitor fits two categories, and the gap map names at least two defensible openings.",
    model: "sonnet",
    tools: RESEARCH,
    keywords: ["competitive", "competitors", "market", "mece", "analysis", "gap"],
  },

  // ---------------- Marketing ----------------
  {
    id: "mkt-seo",
    category: "Marketing",
    title: "On-page SEO audit",
    prompt:
      "Audit the site/pages in this project for on-page SEO fundamentals: one H1 per page that matches search intent, title tags under 60 chars with the primary term early, meta descriptions that earn the click, heading hierarchy, internal links with descriptive anchors, image alt text, and obvious Core-Web-Vitals red flags (huge images, render-blocking scripts). For each issue: location, why it costs ranking or clicks, and the exact fix. Done when: fixes are ranked by impact-for-effort and the top three are applied (if the run allows edits).",
    model: "sonnet",
    tools: EDIT,
    keywords: ["seo", "meta", "audit", "search", "on-page", "ranking"],
  },
  {
    id: "mkt-landing",
    category: "Marketing",
    title: "Landing copy — clarity over cleverness",
    prompt:
      "Write (or rewrite) landing-page copy for the product in this project. Standards: the headline states the outcome the visitor gets, in their words, in under 10 — clever loses to clear; the subhead handles the biggest objection; every feature is phrased as its benefit; social proof is specific (numbers, names) or omitted; one primary CTA repeated, no competing asks. Done when: a stranger reading only headline + CTA can say what this is, who it's for, and what to do next.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["landing", "copy", "headline", "conversion", "cta"],
  },

  // ---------------- Ops & Business ----------------
  {
    id: "ops-postmortem",
    category: "Ops & Business",
    title: "Blameless postmortem (5 Whys)",
    standard: "5 Whys",
    prompt:
      "Write a blameless postmortem for the incident described in this run (or evidenced in this project's logs/history). Timeline with timestamps; impact quantified; root-cause analysis using 5 Whys — stop at systems and incentives, never at a person's name; what went well; and corrective actions each with an owner-role and a due horizon. The standard: a new team member should understand both the failure and why the same class of failure can't recur. Done when: every 'why' chain ends at a system, and every action is verifiable.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["postmortem", "incident", "5 whys", "root cause", "blameless"],
  },
  {
    id: "ops-meeting",
    category: "Ops & Business",
    title: "Minutes → decisions & actions",
    prompt:
      "Turn the meeting notes/transcript in this project into a decision record: decisions made (with the reasoning captured in one line each), actions (owner, deliverable, due), open questions (with who owes the answer), and explicitly-parked topics. Drop the chatter entirely. Done when: someone who missed the meeting can act correctly from this document alone, and every action has an owner and a date.",
    model: "haiku",
    tools: WRITE,
    keywords: ["meeting", "minutes", "actions", "decisions", "notes"],
  },
  {
    id: "ops-okr",
    category: "Ops & Business",
    title: "Draft OKRs that actually measure",
    standard: "OKR",
    prompt:
      "Draft OKRs for the goal defined in this run. Standards: each Objective is qualitative and inspiring; each Key Result is a measured outcome (a number that moves), never an activity or a project name; 3 KRs per objective max; each KR scored 0.0–1.0 with the baseline and target stated. Rewrite any KR that a team could 'complete' without the goal actually improving. Done when: every KR has baseline → target and none contains the words 'launch', 'ship', or 'complete'.",
    model: "sonnet",
    tools: WRITE,
    keywords: ["okr", "goals", "kpi", "objectives", "planning"],
  },
];

/** Case-insensitive search across title, standard, category, and keywords. */
export function searchSteps(query: string, category?: string): LibraryStep[] {
  const q = query.trim().toLowerCase();
  return STEP_LIBRARY.filter((s) => {
    if (category && s.category !== category) return false;
    if (!q) return true;
    const hay = `${s.title} ${s.standard ?? ""} ${s.category} ${s.keywords.join(" ")}`.toLowerCase();
    return q.split(/\s+/).every((part) => hay.includes(part));
  });
}
