/**
 * Coworker personalities: a voice for the working state.
 *
 * A personality changes only what the interface says while a coworker is
 * busy — the small line under the thread, the rail label, the Now card. It
 * never changes how the coworker works or writes, and it never replaces a
 * truthful status: "Needs you", "Retrying", "Failed" always win. Sayings are
 * pre-written, work-oriented, and rotate deterministically so every surface
 * that shows the same coworker agrees on the same phrase at the same moment.
 */

export const PERSONALITIES = [
  "none",
  "neutral",
  "warm",
  "dry",
  "curious",
  "craftsman",
  "librarian",
  "chef",
  "gardener",
  "navigator",
  "detective",
] as const;

export type Personality = (typeof PERSONALITIES)[number];

export const DEFAULT_PERSONALITY: Personality = "neutral";

export const PERSONALITY_OPTIONS: Array<{ id: Personality; label: string; description: string }> = [
  { id: "none", label: "None", description: "Plain status only. Working means working." },
  { id: "neutral", label: "Neutral", description: "Calm, professional progress notes." },
  { id: "warm", label: "Warm", description: "Encouraging, friendly, a little upbeat." },
  { id: "dry", label: "Dry", description: "Deadpan understatement. Rarely impressed." },
  { id: "curious", label: "Curious", description: "An explorer following leads and hunches." },
  { id: "craftsman", label: "Craftsman", description: "Workshop language. Measures twice." },
  { id: "librarian", label: "Librarian", description: "Cross-references, footnotes, quiet stacks." },
  { id: "chef", label: "Chef", description: "Kitchen language. Mise en place first." },
  { id: "gardener", label: "Gardener", description: "Patient tending: prune, water, wait." },
  { id: "navigator", label: "Navigator", description: "Charts, headings, and a steady course." },
  { id: "detective", label: "Detective", description: "Follows the paper trail to the end." },
];

/**
 * Working sayings by personality. Present-participle phrases, no trailing
 * punctuation (the interface adds the ellipsis), nothing that promises a
 * result or describes a specific tool the coworker may not be using.
 */
export const WORKING_SAYINGS: Record<Exclude<Personality, "none">, readonly string[]> = {
  neutral: [
    "Working through it",
    "Reviewing the details",
    "Checking what came back",
    "Lining up the next step",
    "Reading carefully",
    "Making progress",
    "Comparing options",
    "Confirming the facts",
    "Putting the pieces together",
    "Tidying the result",
    "Double-checking",
    "Working on the next part",
    "Getting the details right",
    "Looking at this from another angle",
    "Keeping notes as I go",
    "Verifying before moving on",
    "Sorting what matters from what doesn't",
    "Following the plan",
    "Adjusting the plan",
    "Reviewing the earlier notes",
    "Drafting",
    "Refining the draft",
    "Checking the edge cases",
    "Preparing the summary",
    "Finishing the last step",
    "Almost there",
    "Working steadily",
    "Reading the context",
    "Weighing the trade-offs",
    "Confirming what changed",
    "Cross-checking the numbers",
    "Organizing the findings",
  ],
  warm: [
    "Rolling up my sleeves",
    "Happy to take this one",
    "Getting into it",
    "Making good progress",
    "This is coming together",
    "Nearly there, promise",
    "Giving it a careful look",
    "Taking my time to get it right",
    "Working on something good",
    "Tidying up so it's easy to read",
    "Checking my work",
    "Good news taking shape",
    "One more pass to be sure",
    "Bringing it all together",
    "Reading through your notes",
    "Making sure nothing is missed",
    "Doing the careful part now",
    "Polishing the rough spots",
    "Keeping it simple",
    "Picking up where we left off",
    "Working on it with care",
    "Getting the wording right",
    "Making it clear and useful",
    "Putting the finishing touches on",
    "Almost ready to share",
    "Checking it reads well",
    "Sorting the details",
    "Looking after the small things",
    "Wrapping this up nicely",
    "Taking one more look",
    "Doing my best work here",
    "Glad to be on this",
  ],
  dry: [
    "Doing the boring part properly",
    "Pretending this is easy",
    "Reading the thing nobody read",
    "Consulting the notes, again",
    "Making the obvious explicit",
    "Checking the detail that always bites",
    "Working, allegedly",
    "Confirming what everyone assumed",
    "Finding the catch",
    "Resisting a shortcut",
    "Applying mild skepticism",
    "Doing it the long way, on purpose",
    "Verifying the thing that was 'definitely fine'",
    "Counting to make sure",
    "Un-complicating it",
    "Looking for the footgun",
    "Quietly fixing the typo too",
    "Reading the fine print",
    "Being thorough about it",
    "Removing an adjective",
    "Checking whether it actually works",
    "Making peace with the edge case",
    "Filing this under 'details'",
    "Not rushing this",
    "Making it boring, which is the goal",
    "Trimming the clever part",
    "Reconsidering the plan, briefly",
    "Doing the second check nobody asked for",
    "Keeping expectations modest",
    "Working with the usual enthusiasm",
    "Making sure it's dull enough to trust",
    "Finishing, in a manner of speaking",
  ],
  curious: [
    "Following a hunch",
    "Turning over another stone",
    "Checking the map",
    "Wondering what's behind this",
    "Pulling on a loose thread",
    "Seeing where this leads",
    "Comparing two versions of the story",
    "Asking why, then why again",
    "Poking at the assumption",
    "Tracing it back to the source",
    "Looking around the corner",
    "Testing a small theory",
    "Collecting clues",
    "Noticing a pattern",
    "Reading the part everyone skips",
    "Trying the other door",
    "Following the breadcrumbs",
    "Mapping what I found so far",
    "Chasing down a detail",
    "Peeking under the hood",
    "Connecting two things that shouldn't connect",
    "Checking whether the exception is the rule",
    "Sketching the shape of it",
    "Learning something on the way",
    "Digging one layer deeper",
    "Zooming out for a second",
    "Zooming back in",
    "Finding the interesting part",
    "Retracing my steps",
    "Testing the obvious answer first",
    "Making a note of the surprise",
    "Circling back to the question",
  ],
  craftsman: [
    "Measuring twice",
    "Sanding the edges",
    "Tightening the bolts",
    "Checking the fit",
    "Laying out the pieces",
    "Marking before cutting",
    "Squaring it up",
    "Working the grain",
    "Planing it flush",
    "Reading the plans",
    "Test-fitting the joint",
    "Choosing the right tool",
    "Sharpening first",
    "Clamping it in place",
    "Letting the glue set",
    "Finishing the surface",
    "Checking it's level",
    "Doing the joinery",
    "Cutting to the line",
    "Rounding the corners",
    "Truing the frame",
    "Sweeping the bench",
    "Checking the tolerances",
    "Assembling in order",
    "Dry-fitting before committing",
    "Fixing the wobble",
    "Reinforcing the weak spot",
    "Making it sturdy",
    "Oiling the mechanism",
    "Signing off the piece",
    "Working to the drawing",
    "Building it to last",
  ],
  librarian: [
    "Cross-referencing",
    "Checking the index",
    "Pulling the right volume",
    "Reading the footnotes",
    "Shelving what's done",
    "Dusting off an old note",
    "Comparing editions",
    "Verifying the citation",
    "Filing this properly",
    "Finding the primary source",
    "Reading between the lines",
    "Cataloguing the findings",
    "Consulting the reference desk",
    "Turning to the appendix",
    "Marking the page",
    "Sorting by relevance",
    "Checking the date on this",
    "Looking it up rather than guessing",
    "Keeping the stacks quiet",
    "Summarizing for the card catalog",
    "Reconciling two accounts",
    "Adding a bookmark",
    "Tracing the reference chain",
    "Reading the abstract, then the whole thing",
    "Correcting the record",
    "Putting things back where they belong",
    "Noting what's missing from the shelf",
    "Checking the errata",
    "Annotating in the margin",
    "Confirming the edition",
    "Indexing the new material",
    "Closing the book on this part",
  ],
  chef: [
    "Prepping the ingredients",
    "Doing the mise en place",
    "Tasting as I go",
    "Reducing the sauce",
    "Letting it simmer",
    "Seasoning to taste",
    "Checking the timing",
    "Plating the results",
    "Sharpening the knives",
    "Reading the recipe twice",
    "Adjusting the heat",
    "Folding it in gently",
    "Resting the dough",
    "Cleaning as I cook",
    "Balancing the flavors",
    "Working the line",
    "Checking the pantry",
    "Deglazing the pan",
    "Bringing it to temperature",
    "Trimming the fat",
    "Skimming the top",
    "Finishing with a garnish",
    "Getting the texture right",
    "Wiping the rim",
    "Sending it to the pass",
    "Timing the courses",
    "Keeping the kitchen calm",
    "Doubling the batch",
    "Checking for doneness",
    "Making the stock from scratch",
    "Portioning carefully",
    "Serving it hot",
  ],
  gardener: [
    "Pruning the dead branches",
    "Watering the seedlings",
    "Waiting for things to grow",
    "Turning the soil",
    "Pulling the weeds",
    "Checking the roots",
    "Staking what needs support",
    "Thinning the rows",
    "Composting the leftovers",
    "Planting in straight lines",
    "Reading the weather",
    "Letting it take root",
    "Mulching for later",
    "Deadheading the old blooms",
    "Training the vine",
    "Labeling the beds",
    "Harvesting what's ready",
    "Sowing for next season",
    "Checking for pests",
    "Tidying the borders",
    "Giving it some light",
    "Being patient with it",
    "Repotting into something bigger",
    "Raking it smooth",
    "Watching for new growth",
    "Clearing the path",
    "Feeding the soil",
    "Trimming back the overgrowth",
    "Sheltering the tender parts",
    "Letting the ground rest",
    "Marking where things are planted",
    "Tending the rows",
  ],
  navigator: [
    "Plotting a course",
    "Checking the instruments",
    "Adjusting the heading",
    "Taking a bearing",
    "Reading the charts",
    "Holding steady",
    "Correcting for drift",
    "Marking the position",
    "Watching the horizon",
    "Trimming the sails",
    "Sounding the depth",
    "Logging the progress",
    "Steering around the shallows",
    "Confirming the waypoint",
    "Keeping the course",
    "Checking the compass twice",
    "Estimating time to arrival",
    "Reading the wind",
    "Making way",
    "Charting the last stretch",
    "Avoiding the rocks",
    "Setting the next waypoint",
    "Taking stock of supplies",
    "Waiting for the fog to lift",
    "Recalculating the route",
    "Staying on heading",
    "Noting the landmark",
    "Bringing it about",
    "Closing in on the harbor",
    "Checking the tide tables",
    "Signaling ahead",
    "Approaching the destination",
  ],
  detective: [
    "Following the paper trail",
    "Interviewing the logs",
    "Connecting the dots",
    "Checking the alibi",
    "Looking for what's missing",
    "Dusting for fingerprints",
    "Reconstructing the timeline",
    "Reviewing the evidence",
    "Ruling out the obvious",
    "Questioning the assumption",
    "Examining the scene",
    "Taking notes in shorthand",
    "Comparing the two accounts",
    "Finding the inconsistency",
    "Pulling the file",
    "Tracing the source",
    "Working the case",
    "Following up on a lead",
    "Checking the details twice",
    "Narrowing down the suspects",
    "Reading the small print",
    "Revisiting the first clue",
    "Testing the theory",
    "Corroborating the story",
    "Putting the facts in order",
    "Looking for a motive",
    "Cross-examining the data",
    "Keeping an open mind",
    "Verifying the sequence of events",
    "Closing in on the answer",
    "Writing up the findings",
    "Filing the report",
  ],
};

export function isPersonality(value: unknown): value is Personality {
  return typeof value === "string" && (PERSONALITIES as readonly string[]).includes(value);
}

export function normalizePersonality(value: unknown): Personality {
  return isPersonality(value) ? value : DEFAULT_PERSONALITY;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
}

/** Small deterministic PRNG so every surface showing a coworker rotates through the same order. */
function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let state = hashSeed(seed);
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const held = shuffled[index] as T;
    shuffled[index] = shuffled[swap] as T;
    shuffled[swap] = held;
  }
  return shuffled;
}

/**
 * The saying to show at a given tick. `seed` should identify the coworker and
 * the piece of work (for example `${slug}:${threadId}`) so two coworkers with
 * the same personality do not speak in unison. Returns "" for `none`.
 */
export function workingSaying(personality: Personality, seed: string, tick: number): string {
  if (personality === "none") return "";
  const order = seededShuffle(WORKING_SAYINGS[personality], seed);
  return order[Math.max(0, Math.floor(tick)) % order.length] ?? "";
}

/** A few sayings to preview a personality before choosing it. */
export function previewSayings(personality: Personality, seed: string, count = 3): string[] {
  if (personality === "none") return [];
  return seededShuffle(WORKING_SAYINGS[personality], seed).slice(0, count);
}
