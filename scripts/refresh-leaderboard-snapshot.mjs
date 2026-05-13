#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("packages/octoclaw-router/src/data/leaderboard-snapshot.json");
const target = resolve(process.env.OCTOCLAW_ROUTER_SNAPSHOT_OUT ?? "packages/octoclaw-router/src/data/leaderboard-snapshot.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[router-lite] refreshed leaderboard snapshot: ${target}`);
