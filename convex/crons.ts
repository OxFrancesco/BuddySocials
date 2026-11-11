import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sync accounts", { minutes: 30 }, internal.accounts.syncDue, {});

export default crons;
