import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sync accounts", { minutes: 30 }, internal.accounts.syncDue, {});
crons.interval("delete unused uploads", { hours: 1 }, internal.media.sweep, {});
crons.interval("link instagram users for meta callbacks", { minutes: 15 }, internal.complianceNode.linkInstagramAccounts, {});

export default crons;
