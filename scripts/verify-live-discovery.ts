import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Separate persistent state keeps the synthetic candidate out of user dashboards.
// Only discovery, extraction, and matching handlers run; no application is created.
process.env.APP_MODE = "live";
process.env.DATA_DIR = path.resolve("data/live-verification", randomUUID());
const { config } = await import("../packages/core/config.js");
const { db, put, get, list, id } = await import("../packages/core/db.js");
const { ProfileSchema } = await import("../packages/core/schemas.js");
const { discovery, handleJob } = await import("../packages/core/workflow.js");
const userId = id();
const report: any = {
  at: new Date().toISOString(),
  model: config.model,
  candidate: "synthetic verification profile",
  mode: "live",
  stateDirectory: config.dataDir,
  checks: [],
  listings: [],
};
put(
  "profile",
  userId,
  userId,
  ProfileSchema.parse({
    name: "Integration Verification Candidate",
    email: "verification@example.test",
    education:
      "Synthetic computer science student profile for integration verification",
    skills: ["Python", "SQL", "TypeScript"],
    preferences: {
      keywords: "site:jobs.lever.co software engineering intern India",
      location: "India",
    },
  }),
);
try {
  await discovery(userId, {
    query: "site:jobs.lever.co software engineering intern India",
  });
  const plan = list<any>("plan", userId)[0];
  report.checks.push({
    name: "planning_and_search",
    passed: Boolean(plan?.queries?.length),
  });
  const jobs = db
    .prepare(
      "SELECT * FROM jobs WHERE user_id=? AND kind='extract' ORDER BY created_at LIMIT 3",
    )
    .all(userId) as any[];
  for (const job of jobs) {
    const payload = JSON.parse(job.payload);
    try {
      await handleJob({ user_id: userId, kind: "extract", payload });
      const matchJob = db
        .prepare(
          "SELECT payload FROM jobs WHERE user_id=? AND kind='match' ORDER BY created_at DESC LIMIT 1",
        )
        .get(userId) as any;
      if (!matchJob) throw new Error("Extraction did not queue matching");
      const matchPayload = JSON.parse(matchJob.payload);
      await handleJob({
        user_id: userId,
        kind: "match",
        payload: matchPayload,
      });
      const listing = get<any>("listing", matchPayload.listingId);
      const match = get<any>(
        "match",
        `${userId}:${matchPayload.listingId}`,
        userId,
      );
      if (!listing || !match || listing.provenance !== "live")
        throw new Error("Missing live listing or match");
      report.listings.push({
        title: listing.title,
        company: listing.company,
        url: listing.url,
        score: match.score,
        evidenceFields: Object.keys(listing.evidence),
        requirements: match.requirements.length,
      });
      report.checks.push({
        name: "fetch_extract_ground_match",
        passed: true,
        url: listing.url,
      });
      break;
    } catch (error) {
      report.checks.push({
        name: "candidate_url",
        passed: false,
        url: payload.url,
        error: (error as Error).message,
      });
    }
  }
  report.passed = report.listings.length > 0;
} catch (error) {
  report.passed = false;
  report.checks.push({
    name: "discovery",
    passed: false,
    error: (error as Error).message,
  });
} finally {
  db.close();
  mkdirSync("data", { recursive: true });
  writeFileSync(
    "data/live-discovery-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
